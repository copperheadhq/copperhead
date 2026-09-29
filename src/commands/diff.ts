import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { loadConfig } from '../config.js';
import { children, isList, listNets, listSymbols, parseSexp, pinNets } from '../kicad/sexp.js';
import { resolveInRepo } from '../util/paths.js';

export interface ElectricalSnapshot {
  components: Record<string, { value: string; footprint: string }>;
  pins: Record<string, string | null>;
  nets: string[];
}

export interface ElectricalDiff {
  base: string;
  baseCommit?: string;
  components: { added: string[]; removed: string[]; changed: { ref: string; before: string; after: string }[] };
  connections: { added: string[]; removed: string[] };
  nets: { added: string[]; removed: string[]; renamed: { before: string; after: string }[] };
}

export class ElectricalDiffError extends Error {}

const emptySnapshot = (): ElectricalSnapshot => ({ components: {}, pins: {}, nets: [] });
const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** Read a fully materialized tree. The parser never serializes KiCad files. */
export async function readElectricalSnapshot(schematicPath: string): Promise<ElectricalSnapshot> {
  const symbols = await listSymbols(schematicPath);
  const pins = await pinNets(schematicPath);
  return {
    components: Object.fromEntries(symbols.map((s) => [s.ref, { value: s.value, footprint: s.footprint }])),
    pins: Object.fromEntries(pins.map((p) => [p.ref + '.' + p.pinNumber, p.net])),
    nets: await listNets(schematicPath),
  };
}

function netMembers(snapshot: ElectricalSnapshot, name: string): string {
  return JSON.stringify(Object.keys(snapshot.pins).filter((pin) => snapshot.pins[pin] === name).sort(naturalOrder));
}

export function compareElectrical(
  before: ElectricalSnapshot,
  after: ElectricalSnapshot,
  base = 'pre-run snapshot',
): ElectricalDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ElectricalDiff['components']['changed'] = [];
  for (const [ref, part] of Object.entries(after.components)) {
    if (!Object.hasOwn(before.components, ref)) added.push(ref + ' ' + part.value);
    else {
      const old = before.components[ref]!;
      if (old.value !== part.value || old.footprint !== part.footprint) {
        changed.push({
          ref,
          before: old.value + ' (' + (old.footprint || 'no footprint') + ')',
          after: part.value + ' (' + (part.footprint || 'no footprint') + ')',
        });
      }
    }
  }
  for (const [ref, part] of Object.entries(before.components)) {
    if (!Object.hasOwn(after.components, ref)) removed.push(ref + ' ' + part.value);
  }
  changed.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));

  const addedConnections: string[] = [];
  const removedConnections: string[] = [];
  const keys = new Set([...Object.keys(before.pins), ...Object.keys(after.pins)]);
  for (const key of [...keys].sort(naturalOrder)) {
    const old = before.pins[key] ?? null;
    const next = after.pins[key] ?? null;
    if (old !== next) {
      if (old) removedConnections.push(key + ' → ' + old);
      if (next) addedConnections.push(key + ' → ' + next);
    }
  }

  const beforeNets = new Set(before.nets);
  const afterNets = new Set(after.nets);
  const removedNets = [...beforeNets].filter((net) => !afterNets.has(net)).sort(naturalOrder);
  const addedNets = [...afterNets].filter((net) => !beforeNets.has(net)).sort(naturalOrder);
  const renamed: ElectricalDiff['nets']['renamed'] = [];
  // Infer a rename only from a unique, nonempty, identical pin set.
  // Bare labels and ambiguous matches remain additions/removals.
  for (const old of removedNets) {
    const members = netMembers(before, old);
    if (members === '[]') continue;
    const candidates = addedNets.filter((net) => netMembers(after, net) === members);
    if (candidates.length === 1 && removedNets.filter((net) => netMembers(before, net) === members).length === 1) {
      renamed.push({ before: old, after: candidates[0]! });
    }
  }
  return {
    base,
    components: { added: added.sort(naturalOrder), removed: removed.sort(naturalOrder), changed },
    connections: { added: addedConnections, removed: removedConnections },
    nets: {
      added: addedNets.filter((net) => !renamed.some((pair) => pair.after === net)),
      removed: removedNets.filter((net) => !renamed.some((pair) => pair.before === net)),
      renamed,
    },
  };
}

export function formatElectricalDiff(diff: ElectricalDiff): string {
  const lines = ['Electrical changes since ' + diff.base];
  const c = diff.components;
  const n = diff.connections;
  if (c.added.length) lines.push('', 'Components added:', ...c.added.map((x) => '  + ' + x));
  if (c.removed.length) lines.push('', 'Components removed:', ...c.removed.map((x) => '  - ' + x));
  if (c.changed.length) lines.push('', 'Components changed:', ...c.changed.map((x) => '  ~ ' + x.ref + ': ' + x.before + ' → ' + x.after));
  if (n.added.length) lines.push('', 'Connections added:', ...n.added.map((x) => '  + ' + x));
  if (n.removed.length) lines.push('', 'Connections removed:', ...n.removed.map((x) => '  - ' + x));
  if (diff.nets.renamed.length || diff.nets.added.length || diff.nets.removed.length) {
    lines.push('', 'Nets:');
    for (const pair of diff.nets.renamed) lines.push('  Renamed: ' + pair.before + ' → ' + pair.after);
    for (const net of diff.nets.added) lines.push('  Added: ' + net);
    for (const net of diff.nets.removed) lines.push('  Removed: ' + net);
  }
  if (lines.length === 1) lines.push('', 'No electrical changes.');
  return lines.join('\n');
}

/** Normalize Windows paths before Git/path use, and contain all referenced sheets. */
function schematicPath(file: string): string {
  const posix = file.replace(/\\/g, '/');
  const normalized = path.posix.normalize(posix);
  if (path.posix.isAbsolute(posix) || /^[A-Za-z]:/.test(posix) || normalized === '..' || normalized.startsWith('../')) {
    throw new ElectricalDiffError('schematic path escapes repo root: ' + file);
  }
  if (!normalized.endsWith('.kicad_sch')) throw new ElectricalDiffError('expected a .kicad_sch path: ' + file);
  return normalized;
}

type SheetReader = (relative: string) => Promise<string | null>;

/** Preserve repo-relative paths, copying only referenced sheets into an isolated tree. */
async function snapshotTree(root: string, source: SheetReader, label: string): Promise<ElectricalSnapshot> {
  const temp = await mkdtemp(path.join(tmpdir(), 'copperhead-diff-'));
  const seen = new Set<string>();
  async function materialize(relative: string, required: boolean): Promise<boolean> {
    const file = schematicPath(relative);
    if (seen.has(file)) return true;
    const text = await source(file);
    if (text === null) {
      if (required) throw new ElectricalDiffError('missing referenced sheet "' + file + '" in ' + label);
      return false;
    }
    const node = parseSexp(text)[0];
    if (!node || !isList(node) || node[0] !== 'kicad_sch') {
      throw new ElectricalDiffError('invalid KiCad schematic "' + file + '" in ' + label);
    }
    seen.add(file);
    const target = resolveInRepo(temp, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, 'utf8');
    for (const sheet of children(node, 'sheet')) {
      const reference = children(sheet, 'property').find((p) => p[1] === 'Sheetfile' || p[1] === 'Sheet file')?.[2];
      if (typeof reference !== 'string' || !reference) {
        throw new ElectricalDiffError('sheet without a Sheetfile in "' + file + '" in ' + label);
      }
      const child = reference.replace(/\\/g, '/');
      if (path.posix.isAbsolute(child) || /^[A-Za-z]:/.test(child)) {
        throw new ElectricalDiffError('schematic path escapes repo root: ' + reference);
      }
      await materialize(path.posix.join(path.posix.dirname(file), child), true);
    }
    return true;
  }
  try {
    if (!(await materialize(root, false))) return emptySnapshot();
    return await readElectricalSnapshot(resolveInRepo(temp, root));
  } finally {
    // Exact fresh mkdtemp directory, never a user-supplied path.
    await rm(temp, { recursive: true, force: true });
  }
}

/** Capture before a dry run so --allow-dirty does not compare user work against HEAD. */
export async function readWorkingElectricalSnapshot(repoRoot: string, allowMissing = false): Promise<ElectricalSnapshot> {
  const config = await loadConfig(repoRoot);
  if (!config.schematic) {
    if (allowMissing) return emptySnapshot();
    throw new ElectricalDiffError('no schematic configured in .copperhead/config.json');
  }
  const root = schematicPath(config.schematic);
  const realRoot = await realpath(repoRoot);
  return snapshotTree(root, async (relative) => {
    try {
      const absolute = await realpath(resolveInRepo(realRoot, relative));
      resolveInRepo(realRoot, absolute); // Reject symlinks that leave the repo too.
      return await readFile(absolute, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (relative !== root || allowMissing) return null;
        throw new ElectricalDiffError('configured schematic does not exist: ' + root);
      }
      throw err;
    }
  }, 'working tree');
}

export async function runElectricalDiff(repoRoot: string, base = 'HEAD~1'): Promise<ElectricalDiff> {
  const config = await loadConfig(repoRoot);
  if (!config.schematic) throw new ElectricalDiffError('no schematic configured in .copperhead/config.json');
  const root = schematicPath(config.schematic);
  let revision: string;
  try {
    revision = (await execa('git', ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'], { cwd: repoRoot })).stdout;
  } catch {
    throw new ElectricalDiffError('cannot resolve base revision "' + base + '"; use an existing local Git commit, branch, or tag');
  }
  const before = await snapshotTree(root, async (file) => {
    try {
      const entry = await execa('git', ['--literal-pathspecs', 'ls-tree', '-z', revision, '--', file], { cwd: repoRoot });
      if (!entry.stdout) return null;
      if (!/^100(644|755) blob /.test(entry.stdout)) {
        throw new ElectricalDiffError('baseline schematic is not a regular file: ' + file);
      }
      return (await execa('git', ['show', revision + ':' + file], { cwd: repoRoot, stripFinalNewline: false })).stdout;
    } catch (err) {
      if (err instanceof ElectricalDiffError) throw err;
      throw new ElectricalDiffError('cannot read schematic "' + file + '" from base revision "' + base + '"');
    }
  }, 'base revision "' + base + '"');
  const after = await readWorkingElectricalSnapshot(repoRoot);
  return { ...compareElectrical(before, after, base), baseCommit: revision };
}

import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { loadConfig } from '../config.js';
import {
  children,
  isList,
  listNets,
  listSymbols,
  parseSexp,
  pinNetsWithGroups,
  type PinGroupNet,
  type PinNet,
  type SchematicSymbol,
} from '../kicad/sexp.js';
import { normalizeFootprint } from '../memory/bom-table.js';
import { loadConstraints, type ConstraintRegistry } from '../memory/constraints.js';
import { fileAtCommit } from '../util/git.js';
import { resolveInRepo, SandboxError } from '../util/paths.js';

export class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffError';
  }
}

export interface ComponentAdded {
  ref: string;
  value: string;
  footprint: string;
  libId: string;
  nets: string[];
}

export interface ComponentFieldChange {
  field: 'value' | 'footprint' | 'libId';
  before: string;
  after: string;
}

export interface ComponentModified {
  ref: string;
  changes: ComponentFieldChange[];
}

export interface ComponentRemoved {
  ref: string;
  value: string;
  footprint: string;
  libId: string;
}

export interface PinConnectionChange {
  kind: 'connected' | 'disconnected';
  ref: string;
  pinNumber: string;
  pinName: string;
  pinLabel: string;
  net: string;
}

export interface NetMergeWarning {
  nets: [string, string];
  into: string;
}

export interface NetRename {
  from: string;
  to: string;
}

export interface DiffResult {
  base: string;
  schematic: string;
  hasChanges: boolean;
  components: {
    added: ComponentAdded[];
    modified: ComponentModified[];
    removed: ComponentRemoved[];
  };
  connections: {
    changes: PinConnectionChange[];
    mergedNets: NetMergeWarning[];
  };
  nets: {
    renamed: NetRename[];
    added: string[];
    removed: string[];
  };
  affectedConstraints: string[];
}

export interface ElectricalSnapshot {
  symbols: SchematicSymbol[];
  nets: string[];
  pins: PinGroupNet[];
}

function sheetSubfiles(text: string): string[] {
  const root = parseSexp(text)[0];
  if (!root || !isList(root)) return [];
  const out: string[] = [];
  for (const sheet of children(root, 'sheet')) {
    for (const p of children(sheet, 'property')) {
      const k = typeof p[1] === 'string' ? p[1] : undefined;
      const v = typeof p[2] === 'string' ? p[2] : undefined;
      if ((k === 'Sheetfile' || k === 'Sheet file') && v) {
        out.push(v);
      }
    }
  }
  return out;
}

async function verifyRevision(repoRoot: string, rev: string): Promise<string> {
  const trimmed = rev.trim();
  if (!trimmed || trimmed.startsWith('-')) {
    throw new DiffError(`cannot resolve git revision "${rev}"`);
  }
  const res = await execa('git', ['rev-parse', '--verify', '--end-of-options', `${trimmed}^{commit}`], {
    cwd: repoRoot,
    reject: false,
  });
  if (res.exitCode !== 0 || !res.stdout.trim()) {
    throw new DiffError(`cannot resolve git revision "${rev}"`);
  }
  return res.stdout.trim();
}

function assertSafeSubsheetRef(sub: string): void {
  if (path.posix.isAbsolute(sub) || path.win32.isAbsolute(sub)) {
    throw new DiffError(`schematic sub-sheet path escapes repository: ${sub}`);
  }
}

async function collectSheetRelPaths(
  repoRoot: string,
  schematicRel: string,
  headSha: string,
): Promise<string[]> {
  const paths = new Set<string>();
  const walkWork = async (rel: string): Promise<void> => {
    const norm = rel.split(path.sep).join('/');
    if (paths.has(norm)) return;
    let full: string;
    try {
      full = resolveInRepo(repoRoot, norm);
    } catch {
      return;
    }
    paths.add(norm);
    if (!existsSync(full)) return;
    const text = await readFile(full, 'utf8');
    for (const sub of sheetSubfiles(text)) {
      if (path.posix.isAbsolute(sub) || path.win32.isAbsolute(sub)) continue;
      const subRel = path.posix.join(path.posix.dirname(norm), sub.split('\\').join('/'));
      await walkWork(subRel);
    }
  };
  await walkWork(schematicRel);

  const visitedHead = new Set<string>();
  const walkHead = async (rel: string): Promise<void> => {
    const norm = rel.split(path.sep).join('/');
    if (visitedHead.has(norm)) return;
    visitedHead.add(norm);
    try {
      resolveInRepo(repoRoot, norm);
    } catch {
      return;
    }
    const text = await fileAtCommit(repoRoot, headSha, norm);
    if (text === null) return;
    paths.add(norm);
    for (const sub of sheetSubfiles(text)) {
      if (path.posix.isAbsolute(sub) || path.win32.isAbsolute(sub)) continue;
      const subRel = path.posix.join(path.posix.dirname(norm), sub.split('\\').join('/'));
      await walkHead(subRel);
    }
  };
  await walkHead(schematicRel);
  return [...paths];
}

async function resolveDefaultBase(repoRoot: string, schematicRel: string): Promise<string> {
  const headRes = await execa('git', ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], {
    cwd: repoRoot,
    reject: false,
  });
  if (headRes.exitCode !== 0) {
    throw new DiffError('cannot resolve git revision "HEAD"');
  }
  const headSha = headRes.stdout.trim();
  const sheetPaths = await collectSheetRelPaths(repoRoot, schematicRel, headSha);
  if (sheetPaths.length > 0) {
    const statusRes = await execa('git', ['status', '--porcelain', '--', ...sheetPaths], {
      cwd: repoRoot,
      reject: false,
    });
    if (statusRes.exitCode === 0 && statusRes.stdout.trim().length > 0) {
      return 'HEAD';
    }
  }
  const parentRes = await execa('git', ['rev-parse', '--verify', '--end-of-options', 'HEAD~1^{commit}'], {
    cwd: repoRoot,
    reject: false,
  });
  return parentRes.exitCode === 0 ? 'HEAD~1' : 'HEAD';
}

async function listCommitSymSupportFiles(repoRoot: string, commitSha: string): Promise<string[]> {
  const res = await execa('git', ['ls-tree', '-r', '--name-only', commitSha, '--'], {
    cwd: repoRoot,
    reject: false,
  });
  if (res.exitCode !== 0 || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(
      (f) =>
        f.length > 0 &&
        (path.posix.basename(f) === 'sym-lib-table' ||
          f.endsWith('.kicad_sym') ||
          f.endsWith('.kicad_pro')),
    );
}

export async function snapshotAtCommit(
  repoRoot: string,
  commitSha: string,
  schematicRel: string,
): Promise<ElectricalSnapshot> {
  const normSchematic = schematicRel.split(path.sep).join('/');
  const rootBytes = await fileAtCommit(repoRoot, commitSha, normSchematic);
  if (rootBytes === null) {
    return { symbols: [], nets: [], pins: [] };
  }
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'copperhead-diff-'));
  try {
    const visited = new Set<string>();
    const materialize = async (relPath: string, isSubsheet: boolean): Promise<void> => {
      const norm = relPath.split(path.sep).join('/');
      if (visited.has(norm)) return;
      visited.add(norm);
      let dest: string;
      try {
        dest = resolveInRepo(tempRoot, norm);
        resolveInRepo(repoRoot, norm);
      } catch (err) {
        if (err instanceof SandboxError) {
          throw new DiffError(`schematic sub-sheet path escapes repository: ${relPath}`);
        }
        throw err;
      }
      const content = await fileAtCommit(repoRoot, commitSha, norm);
      if (content === null) {
        if (isSubsheet) {
          throw new DiffError(
            `schematic sub-sheet "${norm}" referenced at ${commitSha.slice(0, 7)} is missing from that commit`,
          );
        }
        return;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content, 'utf8');
      for (const sub of sheetSubfiles(content)) {
        assertSafeSubsheetRef(sub);
        const subNorm = sub.split('\\').join('/');
        const subRel = path.posix.join(path.posix.dirname(norm), subNorm);
        await materialize(subRel, true);
      }
    };
    await materialize(normSchematic, false);
    for (const supportRel of await listCommitSymSupportFiles(repoRoot, commitSha)) {
      if (visited.has(supportRel)) continue;
      let dest: string;
      try {
        dest = resolveInRepo(tempRoot, supportRel);
      } catch {
        continue;
      }
      const content = await fileAtCommit(repoRoot, commitSha, supportRel);
      if (content === null) continue;
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content, 'utf8');
    }
    const rootSch = resolveInRepo(tempRoot, normSchematic);
    const [symbols, nets, pins] = await Promise.all([
      listSymbols(rootSch),
      listNets(rootSch),
      pinNetsWithGroups(rootSch),
    ]);
    return { symbols, nets, pins };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function validateWorkingSubsheets(
  repoRoot: string,
  schematicRel: string,
  isSubsheet = false,
  visited = new Set<string>(),
): Promise<void> {
  const norm = schematicRel.split(path.sep).join('/');
  if (visited.has(norm)) return;
  visited.add(norm);
  let fullPath: string;
  try {
    fullPath = resolveInRepo(repoRoot, norm);
  } catch (err) {
    if (err instanceof SandboxError) {
      throw new DiffError(`schematic sub-sheet path escapes repository: ${schematicRel}`);
    }
    throw err;
  }
  if (!existsSync(fullPath)) {
    if (isSubsheet) {
      throw new DiffError(`schematic sub-sheet not found at ${norm}`);
    }
    return;
  }
  const content = await readFile(fullPath, 'utf8');
  for (const sub of sheetSubfiles(content)) {
    assertSafeSubsheetRef(sub);
    const subNorm = sub.split('\\').join('/');
    const subRel = path.posix.join(path.posix.dirname(norm), subNorm);
    await validateWorkingSubsheets(repoRoot, subRel, true, visited);
  }
}

async function snapshotWorkingTree(repoRoot: string, schematicRel: string): Promise<ElectricalSnapshot> {
  let rootSch: string;
  try {
    rootSch = resolveInRepo(repoRoot, schematicRel);
  } catch (err) {
    if (err instanceof SandboxError) {
      throw new DiffError(`schematic path escapes repository: ${schematicRel}`);
    }
    throw err;
  }
  if (!existsSync(rootSch)) {
    throw new DiffError(`schematic not found at ${schematicRel}`);
  }
  await validateWorkingSubsheets(repoRoot, schematicRel, false);
  const [symbols, nets, pins] = await Promise.all([
    listSymbols(rootSch),
    listNets(rootSch),
    pinNetsWithGroups(rootSch),
  ]);
  return { symbols, nets, pins };
}

function collapseSymbols(symbols: SchematicSymbol[]): Map<string, SchematicSymbol> {
  const byRef = new Map<string, SchematicSymbol>();
  for (const sym of symbols) {
    const existing = byRef.get(sym.ref);
    if (!existing || sym.unit === 1) {
      byRef.set(sym.ref, sym);
    }
  }
  return byRef;
}

function formatPinLabel(p: PinNet): string {
  const suffix = p.pinName && p.pinName !== '~' ? p.pinName : p.pinNumber;
  return `${p.ref}.${suffix}`;
}

function hasTokenMatch(target: string, token: string): boolean {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.:])${escaped}(?![A-Za-z0-9_.:])`, 'i').test(target);
}

function hasRefTokenMatch(target: string, ref: string): boolean {
  if (!ref) return false;
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.:])${escaped}(?![A-Za-z0-9_])`, 'i').test(target);
}

function effectivePinNet(p: PinGroupNet | undefined): string | null {
  if (!p) return null;
  if (p.net !== null) return p.net;
  if (p.group && p.group.length >= 2) return `~{${p.group.join(',')}}`;
  return null;
}

function matchAffectedConstraints(
  registry: ConstraintRegistry,
  touchedRefs: Set<string>,
  touchedNets: Set<string>,
  touchedPins: Set<string>,
): string[] {
  const matched: string[] = [];
  for (const [key, constraint] of Object.entries(registry)) {
    const targets = [...(constraint.affects ?? []), ...(constraint.deferred ?? [])];
    let hit = false;
    for (const target of targets) {
      for (const ref of touchedRefs) {
        if (hasRefTokenMatch(target, ref)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
      for (const net of touchedNets) {
        if (hasTokenMatch(target, net)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
      for (const pin of touchedPins) {
        if (hasTokenMatch(target, pin)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) matched.push(key);
  }
  return matched.sort();
}

export function diffSnapshots(
  base: string,
  schematic: string,
  before: ElectricalSnapshot,
  after: ElectricalSnapshot,
  constraints: ConstraintRegistry = {},
): DiffResult {
  const beforeSyms = collapseSymbols(before.symbols);
  const afterSyms = collapseSymbols(after.symbols);

  const beforeNetsByRef = new Map<string, Set<string>>();
  for (const p of before.pins) {
    const n = effectivePinNet(p);
    if (!n) continue;
    let set = beforeNetsByRef.get(p.ref);
    if (!set) {
      set = new Set<string>();
      beforeNetsByRef.set(p.ref, set);
    }
    set.add(n);
  }

  const afterNetsByRef = new Map<string, Set<string>>();
  for (const p of after.pins) {
    const n = effectivePinNet(p);
    if (!n) continue;
    let set = afterNetsByRef.get(p.ref);
    if (!set) {
      set = new Set<string>();
      afterNetsByRef.set(p.ref, set);
    }
    set.add(n);
  }

  const addedComponents: ComponentAdded[] = [];
  const modifiedComponents: ComponentModified[] = [];
  const removedComponents: ComponentRemoved[] = [];
  const touchedRefs = new Set<string>();
  const touchedNets = new Set<string>();
  const touchedPins = new Set<string>();

  const allRefs = [...new Set([...beforeSyms.keys(), ...afterSyms.keys()])].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );

  for (const ref of allRefs) {
    const b = beforeSyms.get(ref);
    const a = afterSyms.get(ref);
    if (!b && a) {
      const nets = [...(afterNetsByRef.get(ref) ?? [])].sort();
      addedComponents.push({
        ref: a.ref,
        value: a.value,
        footprint: a.footprint,
        libId: a.libId,
        nets,
      });
      touchedRefs.add(ref);
      for (const n of nets) touchedNets.add(n);
    } else if (b && !a) {
      removedComponents.push({
        ref: b.ref,
        value: b.value,
        footprint: b.footprint,
        libId: b.libId,
      });
      touchedRefs.add(ref);
      for (const n of beforeNetsByRef.get(ref) ?? []) touchedNets.add(n);
    } else if (b && a) {
      const changes: ComponentFieldChange[] = [];
      if (normalizeFootprint(b.value) !== normalizeFootprint(a.value)) {
        changes.push({ field: 'value', before: b.value, after: a.value });
      }
      if (normalizeFootprint(b.footprint) !== normalizeFootprint(a.footprint)) {
        changes.push({ field: 'footprint', before: b.footprint, after: a.footprint });
      }
      if (b.libId !== a.libId) {
        changes.push({ field: 'libId', before: b.libId, after: a.libId });
      }
      if (changes.length > 0) {
        modifiedComponents.push({ ref, changes });
        touchedRefs.add(ref);
      }
    }
  }

  const pinKey = (p: PinNet): string => `${p.ref}:${p.pinNumber}`;
  const beforePins = new Map<string, PinGroupNet>(before.pins.map((p) => [pinKey(p), p]));
  const afterPins = new Map<string, PinGroupNet>(after.pins.map((p) => [pinKey(p), p]));
  const allPinKeys = [...new Set([...beforePins.keys(), ...afterPins.keys()])].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );

  const connectionChanges: PinConnectionChange[] = [];
  for (const k of allPinKeys) {
    const bp = beforePins.get(k);
    const ap = afterPins.get(k);
    const ref = (ap ?? bp)!.ref;
    // Pin connection changes under Connections: apply only to surviving
    // components; added/removed components are already summarized under Components:.
    if (!beforeSyms.has(ref) || !afterSyms.has(ref)) continue;

    const bNet = effectivePinNet(bp);
    const aNet = effectivePinNet(ap);
    if (bNet === aNet) continue;

    if (ap && aNet !== null) {
      const label = formatPinLabel(ap);
      connectionChanges.push({
        kind: 'connected',
        ref: ap.ref,
        pinNumber: ap.pinNumber,
        pinName: ap.pinName,
        pinLabel: label,
        net: aNet,
      });
      touchedNets.add(aNet);
      touchedPins.add(label);
      touchedPins.add(`${ap.ref}.${ap.pinNumber}`);
    }
    if (bp && bNet !== null) {
      const label = formatPinLabel(bp);
      connectionChanges.push({
        kind: 'disconnected',
        ref: bp.ref,
        pinNumber: bp.pinNumber,
        pinName: bp.pinName,
        pinLabel: label,
        net: bNet,
      });
      touchedNets.add(bNet);
      touchedPins.add(label);
      touchedPins.add(`${bp.ref}.${bp.pinNumber}`);
    }
  }

  // Detect merged nets: two distinct multi-pin nets in `before` whose surviving
  // pins now sit on a single shared net in `after`.
  const beforeNetPins = new Map<string, Set<string>>();
  for (const p of before.pins) {
    if (!p.net) continue;
    let s = beforeNetPins.get(p.net);
    if (!s) {
      s = new Set<string>();
      beforeNetPins.set(p.net, s);
    }
    s.add(pinKey(p));
  }
  const afterNetPins = new Map<string, Set<string>>();
  for (const p of after.pins) {
    if (!p.net) continue;
    let s = afterNetPins.get(p.net);
    if (!s) {
      s = new Set<string>();
      afterNetPins.set(p.net, s);
    }
    s.add(pinKey(p));
  }

  const survivingPinKeys = (pins: Set<string> | undefined): string[] => {
    if (!pins) return [];
    return [...pins]
      .filter((pk) => {
        const r = pk.split(':')[0]!;
        return beforeSyms.has(r) && afterSyms.has(r);
      })
      .sort();
  };

  const mergedNets: NetMergeWarning[] = [];
  const seenMergePairs = new Set<string>();
  for (const [afterNet, aPins] of afterNetPins.entries()) {
    const contributingBeforeNets: string[] = [];
    for (const [bNet, bPins] of beforeNetPins.entries()) {
      const survivingPins = survivingPinKeys(bPins);
      if (survivingPins.length < 2) continue;
      const overlap = survivingPins.filter((pk) => aPins.has(pk));
      if (overlap.length >= 2 && overlap.length === survivingPins.length) {
        contributingBeforeNets.push(bNet);
      }
    }
    contributingBeforeNets.sort();
    if (contributingBeforeNets.length >= 2) {
      for (let i = 0; i < contributingBeforeNets.length; i++) {
        for (let j = i + 1; j < contributingBeforeNets.length; j++) {
          const pair: [string, string] = [contributingBeforeNets[i]!, contributingBeforeNets[j]!];
          const pairKey = `${pair[0]}::${pair[1]}`;
          if (!seenMergePairs.has(pairKey)) {
            seenMergePairs.add(pairKey);
            mergedNets.push({ nets: pair, into: afterNet });
            touchedNets.add(pair[0]);
            touchedNets.add(pair[1]);
            touchedNets.add(afterNet);
          }
        }
      }
    }
  }
  mergedNets.sort(
    (x, y) =>
      x.into.localeCompare(y.into) ||
      x.nets[0].localeCompare(y.nets[0]) ||
      x.nets[1].localeCompare(y.nets[1]),
  );

  const beforeNetSet = new Set(before.nets);
  const afterNetSet = new Set(after.nets);
  const rawRemovedNets = [...beforeNetSet].filter((n) => !afterNetSet.has(n)).sort();
  const rawAddedNets = [...afterNetSet].filter((n) => !beforeNetSet.has(n)).sort();

  const renamed: NetRename[] = [];
  const matchedRemoved = new Set<string>();
  const matchedAdded = new Set<string>();

  for (const oldNet of rawRemovedNets) {
    const oldSurviving = survivingPinKeys(beforeNetPins.get(oldNet));
    const oldSig = oldSurviving.length > 0 ? oldSurviving.join(',') : [...(beforeNetPins.get(oldNet) ?? [])].sort().join(',');
    if (!oldSig) continue;
    for (const newNet of rawAddedNets) {
      if (matchedAdded.has(newNet)) continue;
      const newSurviving = survivingPinKeys(afterNetPins.get(newNet));
      const newSig = newSurviving.length > 0 ? newSurviving.join(',') : [...(afterNetPins.get(newNet) ?? [])].sort().join(',');
      if (!newSig) continue;
      if (oldSig === newSig) {
        renamed.push({ from: oldNet, to: newNet });
        matchedRemoved.add(oldNet);
        matchedAdded.add(newNet);
        touchedNets.add(oldNet);
        touchedNets.add(newNet);
        break;
      }
    }
  }

  const addedNets = rawAddedNets.filter((n) => !matchedAdded.has(n));
  const removedNets = rawRemovedNets.filter((n) => !matchedRemoved.has(n));
  for (const n of addedNets) touchedNets.add(n);
  for (const n of removedNets) touchedNets.add(n);

  const affectedConstraints = matchAffectedConstraints(
    constraints,
    touchedRefs,
    touchedNets,
    touchedPins,
  );

  const hasChanges =
    addedComponents.length > 0 ||
    modifiedComponents.length > 0 ||
    removedComponents.length > 0 ||
    connectionChanges.length > 0 ||
    mergedNets.length > 0 ||
    renamed.length > 0 ||
    addedNets.length > 0 ||
    removedNets.length > 0;

  return {
    base,
    schematic,
    hasChanges,
    components: {
      added: addedComponents,
      modified: modifiedComponents,
      removed: removedComponents,
    },
    connections: {
      changes: connectionChanges,
      mergedNets,
    },
    nets: {
      renamed,
      added: addedNets,
      removed: removedNets,
    },
    affectedConstraints,
  };
}

export async function runDiff(
  repoRoot: string,
  opts: { base?: string } = {},
): Promise<DiffResult> {
  const config = await loadConfig(repoRoot);
  if (!config.schematic) {
    throw new DiffError('no schematic configured (run copperhead init)');
  }
  const base = opts.base ?? (await resolveDefaultBase(repoRoot, config.schematic));
  const commitSha = await verifyRevision(repoRoot, base);
  const settled = await Promise.allSettled([
    snapshotAtCommit(repoRoot, commitSha, config.schematic),
    snapshotWorkingTree(repoRoot, config.schematic),
    loadConstraints(repoRoot),
  ]);
  for (const item of settled) {
    if (item.status === 'rejected') throw item.reason;
  }
  const before = (settled[0] as PromiseFulfilledResult<ElectricalSnapshot>).value;
  const after = (settled[1] as PromiseFulfilledResult<ElectricalSnapshot>).value;
  const constraints = (settled[2] as PromiseFulfilledResult<ConstraintRegistry>).value;
  return diffSnapshots(base, config.schematic, before, after, constraints);
}

export function formatDiffReport(res: DiffResult): string {
  if (!res.hasChanges) {
    return `No electrical changes since ${res.base}`;
  }
  const lines: string[] = [`Electrical changes since ${res.base}`];

  if (
    res.components.added.length > 0 ||
    res.components.modified.length > 0 ||
    res.components.removed.length > 0
  ) {
    lines.push('', 'Components:');
    for (const c of res.components.added) {
      const netSuffix = c.nets.length > 0 ? ` -> ${c.nets.join(', ')}` : '';
      lines.push(`  + ${c.ref} ${c.value}${netSuffix}`);
    }
    for (const m of res.components.modified) {
      for (const ch of m.changes) {
        lines.push(`  ~ ${m.ref} ${ch.field} changed (${ch.before} -> ${ch.after})`);
      }
    }
    for (const r of res.components.removed) {
      lines.push(`  - ${r.ref} removed`);
    }
  }

  if (res.connections.changes.length > 0 || res.connections.mergedNets.length > 0) {
    lines.push('', 'Connections:');
    for (const c of res.connections.changes) {
      if (c.kind === 'connected') {
        lines.push(`  + ${c.pinLabel} connected to ${c.net}`);
      } else {
        lines.push(`  - ${c.pinLabel} disconnected from ${c.net}`);
      }
    }
    for (const m of res.connections.mergedNets) {
      lines.push(`  ! ${m.nets[0]} and ${m.nets[1]} appear to be merged`);
    }
  }

  if (
    res.nets.renamed.length > 0 ||
    res.nets.added.length > 0 ||
    res.nets.removed.length > 0
  ) {
    lines.push('', 'Nets:');
    for (const r of res.nets.renamed) {
      lines.push(`  Renamed: ${r.from} -> ${r.to}`);
    }
    for (const a of res.nets.added) {
      lines.push(`  Added: ${a}`);
    }
    for (const r of res.nets.removed) {
      lines.push(`  Removed: ${r}`);
    }
  }

  if (res.affectedConstraints.length > 0) {
    lines.push('', 'Affected constraints:');
    for (const k of res.affectedConstraints) {
      lines.push(`  - ${k}`);
    }
  }

  return lines.join('\n');
}

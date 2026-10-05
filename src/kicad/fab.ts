/**
 * Fab release gate checks (OpenSpec: add-fab-release-gate).
 * Documentation presence is pure over file contents: LLM-free, network-free.
 */
import { parseCanonicalTables } from '../memory/bom-table.js';
import { normalizeFootprint } from '../memory/bom-table.js';
import { readFile } from 'node:fs/promises';
import { readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CopperheadConfig } from '../config.js';
import { configPath } from '../config.js';
import type { PinNet, SchematicSymbol } from './sexp.js';
import { listSymbols, parseKicadSexpStrict, pinNets } from './sexp.js';
import { boardFootprints, boardPads } from './populate.js';

/** Violation shape shared by the fab JSON report (`claim` / `actual` / optional location). */
export interface FabViolation {
  claim: string;
  actual: string;
  location?: string;
}

export interface FabCheckResult {
  status: 'pass' | 'warn' | 'fail';
  violations: FabViolation[];
}

/** A fabrication BOM must identify an orderable, reviewed part for every row. */
export function checkBomReadiness(bomMd: string | null, strict = true): FabCheckResult {
  if (bomMd === null) {
    return { status: 'fail', violations: [{ claim: 'orderable BOM', actual: 'BOM.md missing', location: 'BOM.md' }] };
  }
  const tables = parseCanonicalTables(bomMd).filter(({ header }) =>
    header.cells.some((cell) => /^refdes$/i.test(cell.trim())),
  );
  const failures: FabViolation[] = [];
  const warnings: FabViolation[] = [];
  let rowCount = 0;
  for (const { header, rows } of tables) {
    const column = (name: string): number => header.cells.findIndex((cell) => cell.trim().toLowerCase() === name);
    const indices = {
      refdes: column('refdes'),
      value: column('value'),
      footprint: column('footprint'),
      mpn: column('mpn'),
      rationale: column('rationale'),
    };
    for (const [field, index] of Object.entries(indices)) {
      if (index < 0) failures.push({ claim: 'orderable BOM', actual: `BOM has no ${field} column`, location: 'BOM.md' });
    }
    for (const row of rows) {
      rowCount++;
      const ref = indices.refdes >= 0 ? row.cells[indices.refdes]?.trim() : '';
      const label = ref || `row ${rowCount}`;
      for (const field of ['value', 'footprint', 'mpn', 'rationale'] as const) {
        const index = indices[field];
        if (index >= 0 && !row.cells[index]?.trim()) {
          failures.push({ claim: 'orderable BOM', actual: `${label} has no ${field === 'mpn' ? 'MPN' : field}`, location: 'BOM.md' });
        }
      }
      if (row.cells.some((cell) => /\bUNVERIFIED\b/i.test(cell))) {
        warnings.push({ claim: 'verified sourcing', actual: `${label} is UNVERIFIED`, location: 'BOM.md' });
      }
    }
  }
  if (!tables.length || rowCount === 0) {
    failures.push({ claim: 'orderable BOM', actual: 'no BOM rows found', location: 'BOM.md' });
  }
  const violations = [...failures, ...warnings];
  return {
    status: failures.length || (strict && warnings.length) ? 'fail' : warnings.length ? 'warn' : 'pass',
    violations,
  };
}

interface BoardFootprint {
  ref: string;
  footprint: string;
}

interface BoardPad {
  ref: string;
  pad: string;
  net: string;
}

/**
 * KiCad prefixes root-sheet local labels with `/` in a PCB net name, while
 * the schematic reader returns the label itself. It also assigns synthetic
 * `unconnected-(...)` names to PCB pads whose schematic pin has no net.
 * Canonicalise only those two representations: hierarchical `/sheet/net`
 * names remain distinct because dropping their path could merge real nets.
 */
function canonicalParityNet(net: string): string {
  if (/^unconnected-\(/i.test(net)) return '';
  if (/^\/[^/]+$/.test(net)) return net.slice(1);
  return net;
}

/** Compare component identity, footprint ids, pad sets, and pad-net assignments. */
export function compareSchematicPcbParity(
  symbols: SchematicSymbol[],
  schematicPins: PinNet[],
  footprints: BoardFootprint[],
  pads: BoardPad[],
): FabCheckResult {
  const violations: FabViolation[] = [];
  if (symbols.length === 0 && footprints.length === 0) {
    return {
      status: 'fail',
      violations: [{ claim: 'schematic/PCB parity', actual: 'schematic and PCB contain no components' }],
    };
  }
  const schParts = new Map(symbols.map((symbol) => [symbol.ref, symbol]));
  const pcbParts = new Map(footprints.map((footprint) => [footprint.ref, footprint]));

  for (const [ref, symbol] of schParts) {
    const footprint = pcbParts.get(ref);
    if (!footprint) {
      violations.push({ claim: 'schematic/PCB parity', actual: `${ref} is missing from PCB`, location: ref });
    } else if (normalizeFootprint(footprint.footprint) !== normalizeFootprint(symbol.footprint)) {
      violations.push({
        claim: 'schematic/PCB parity',
        actual: `${ref} footprint is ${footprint.footprint || '(none)'} on PCB, ${symbol.footprint || '(none)'} in schematic`,
        location: ref,
      });
    }
  }
  for (const ref of pcbParts.keys()) {
    if (!schParts.has(ref)) {
      violations.push({ claim: 'schematic/PCB parity', actual: `${ref} is absent from schematic`, location: ref });
    }
  }

  const expectedPads = new Map(schematicPins.map((pin) => [`${pin.ref}\0${pin.pinNumber}`, pin.net ?? '']));
  const actualPads = new Map(pads.map((pad) => [`${pad.ref}\0${pad.pad}`, pad.net]));
  for (const [key, expectedNet] of expectedPads) {
    const [ref, pad] = key.split('\0');
    if (!pcbParts.has(ref!)) continue;
    if (!actualPads.has(key)) {
      violations.push({ claim: 'schematic/PCB parity', actual: `${ref}.${pad} is missing from PCB footprint`, location: ref });
    } else if (canonicalParityNet(actualPads.get(key) ?? '') !== canonicalParityNet(expectedNet)) {
      violations.push({
        claim: 'schematic/PCB parity',
        actual: `${ref}.${pad} is on ${actualPads.get(key) || 'no net'} on PCB, ${expectedNet || 'no net'} in schematic`,
        location: ref,
      });
    }
  }
  for (const key of actualPads.keys()) {
    const [ref, pad] = key.split('\0');
    if (schParts.has(ref!) && !expectedPads.has(key)) {
      violations.push({ claim: 'schematic/PCB parity', actual: `${ref}.${pad} has no matching schematic pin`, location: ref });
    }
  }

  return { status: violations.length ? 'fail' : 'pass', violations };
}

export async function checkSchematicPcbParity(
  schematicPath: string | null,
  boardPath: string | null,
): Promise<FabCheckResult> {
  if (!schematicPath || !boardPath || !existsSync(schematicPath) || !existsSync(boardPath)) {
    return {
      status: 'fail',
      violations: [{ claim: 'schematic/PCB parity', actual: 'schematic or PCB file is missing' }],
    };
  }
  try {
    const [schematicText, boardText] = await Promise.all([
      readFile(schematicPath, 'utf8'),
      readFile(boardPath, 'utf8'),
    ]);
    parseKicadSexpStrict(schematicText, 'kicad_sch');
    parseKicadSexpStrict(boardText, 'kicad_pcb');
    const [symbols, pins] = await Promise.all([listSymbols(schematicPath), pinNets(schematicPath)]);
    return compareSchematicPcbParity(symbols, pins, boardFootprints(boardText), boardPads(boardText));
  } catch (error) {
    return {
      status: 'fail',
      violations: [{
        claim: 'parseable schematic/PCB',
        actual: `fabrication parity could not be checked: ${(error as Error).message}`,
      }],
    };
  }
}

const GERBER_RE = /\.(?:gbr|gtl|gbl|gts|gbs|gto|gbo|gml)$/i;
const DRILL_RE = /\.drl$/i;

async function filesBelow(repoRoot: string, directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(repoRoot, absolute));
    else if (entry.isFile()) files.push(path.relative(repoRoot, absolute));
  }
  return files.sort();
}

export async function validateFabricationOutputs(
  repoRoot: string,
  outputDirectory = 'outputs',
): Promise<{ files: string[]; violations: string[] }> {
  const files = await filesBelow(repoRoot, path.join(repoRoot, outputDirectory));
  const violations: string[] = [];
  if (!files.some((file) => GERBER_RE.test(file))) violations.push('Gerber package missing');
  if (!files.some((file) => DRILL_RE.test(file))) violations.push('drill package missing');
  return { files, violations };
}

/** Remove an older success marker before a new exporter attempt begins. */
export async function clearFabOutputProvenance(repoRoot: string, config: CopperheadConfig): Promise<boolean> {
  const file = configPath(repoRoot);
  if (!existsSync(file)) {
    delete config.fabOutputs;
    return false;
  }
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const changed = Object.hasOwn(raw, 'fabOutputs');
  delete raw.fabOutputs;
  delete config.fabOutputs;
  if (changed) await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return changed;
}

/** Record provenance only after every exporter and required file check passes. */
export async function recordFabOutputProvenance(
  repoRoot: string,
  config: CopperheadConfig,
  files: string[],
): Promise<void> {
  if (!config.board) throw new Error('cannot record fabrication outputs without a configured board');
  const file = configPath(repoRoot);
  const raw = existsSync(file)
    ? JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    : { ...config };
  const fabOutputs = {
    boardSha256: createHash('sha256').update(await readFile(path.join(repoRoot, config.board))).digest('hex'),
    files: [...files].sort(),
    generatedAt: new Date().toISOString(),
  };
  raw.fabOutputs = fabOutputs;
  config.fabOutputs = fabOutputs;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

/** Verify that recorded fabrication files still belong to the current board. */
export async function checkFabOutputProvenance(
  repoRoot: string,
  config: CopperheadConfig,
): Promise<FabCheckResult> {
  const record = config.fabOutputs;
  if (!config.board || !existsSync(path.join(repoRoot, config.board))) {
    return { status: 'fail', violations: [{ claim: 'current fabrication outputs', actual: 'configured board is missing' }] };
  }
  if (!record) {
    return { status: 'fail', violations: [{ claim: 'current fabrication outputs', actual: 'export provenance is missing' }] };
  }
  const violations: FabViolation[] = [];
  const currentHash = createHash('sha256').update(await readFile(path.join(repoRoot, config.board))).digest('hex');
  if (currentHash !== record.boardSha256) {
    violations.push({ claim: 'current fabrication outputs', actual: 'recorded outputs are stale for the current board' });
  }
  const root = path.resolve(repoRoot);
  for (const file of record.files) {
    const absolute = path.resolve(repoRoot, file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      violations.push({ claim: 'current fabrication outputs', actual: 'recorded output path escapes the repository', location: file });
    } else if (!existsSync(absolute)) {
      violations.push({ claim: 'current fabrication outputs', actual: 'recorded output is missing', location: file });
    }
  }
  const present = record.files.filter((file) => existsSync(path.resolve(repoRoot, file)));
  if (!present.some((file) => GERBER_RE.test(file))) {
    violations.push({ claim: 'current fabrication outputs', actual: 'recorded Gerber package is missing' });
  }
  if (!present.some((file) => DRILL_RE.test(file))) {
    violations.push({ claim: 'current fabrication outputs', actual: 'recorded drill package is missing' });
  }
  return { status: violations.length ? 'fail' : 'pass', violations };
}

export interface FabReport {
  routing: FabCheckResult;
  bom: FabCheckResult;
  schPcbMatch: FabCheckResult;
  outputs: FabCheckResult;
  docs: FabCheckResult;
}

export async function runFabGate(
  repoRoot: string,
  config: CopperheadConfig,
  drc: import('./report.js').CheckReport | null,
  strict = false,
): Promise<FabReport> {
  const docsDir = config.docs.replace(/[/\\]+$/, '');
  const bomPath = path.join(repoRoot, docsDir, 'BOM.md');
  const layoutPath = path.join(repoRoot, docsDir, 'LAYOUT.md');
  const routing: FabCheckResult = drc === null
    ? { status: 'fail', violations: [{ claim: 'fully routed', actual: 'no PCB DRC report available' }] }
    : (drc.unrouted ?? 0) > 0
      ? { status: 'fail', violations: [{ claim: 'fully routed', actual: `${drc.unrouted} unrouted connection(s)` }] }
      : { status: 'pass', violations: [] };
  return {
    routing,
    bom: checkBomReadiness(existsSync(bomPath) ? await readFile(bomPath, 'utf8') : null, strict),
    schPcbMatch: await checkSchematicPcbParity(
      config.schematic ? path.join(repoRoot, config.schematic) : null,
      config.board ? path.join(repoRoot, config.board) : null,
    ),
    outputs: await checkFabOutputProvenance(repoRoot, config),
    docs: checkDocumentationPresence({
      layoutMd: existsSync(layoutPath) ? await readFile(layoutPath, 'utf8') : null,
      devplanExists: existsSync(path.join(repoRoot, docsDir, 'DEVPLAN.md')),
      isCreateRepo: isCreateProducedRepo(config),
      docsDir,
    }),
  };
}

export function fabReportOk(report: FabReport): boolean {
  return Object.values(report).every((result) => result.status !== 'fail');
}

export function formatFabReport(report: FabReport): string {
  const labels: Record<keyof FabReport, string> = {
    routing: 'routing',
    bom: 'BOM',
    schPcbMatch: 'schematic/PCB',
    outputs: 'outputs',
    docs: 'docs',
  };
  const lines: string[] = [];
  for (const key of Object.keys(labels) as (keyof FabReport)[]) {
    const result = report[key];
    const mark = result.status === 'pass' ? '✓' : result.status === 'warn' ? '⚠' : '✗';
    lines.push(`fab ${labels[key]} ${mark}`);
    for (const violation of result.violations) {
      lines.push(`  ${violation.claim}: ${violation.actual}${violation.location ? ` (${violation.location})` : ''}`);
    }
  }
  return lines.join('\n');
}

export const DRAFT_QUALITY_HEADING = '## Draft quality';

/** Config marker: repos produced by `copperhead create` set `origin` to `"create"`. */
export const CREATE_ORIGIN = 'create';

/** Generator stamp carried by every schematic copperhead authors (the
 * bootstrap scaffold and every emitter draft). */
export const DRAFT_GENERATOR_MARKER = '(generator "copperhead-draft")';

/**
 * Is the schematic still copperhead-authored? True while the file carries the
 * generator stamp. A human taking the sheet over in KiCad re-saves it with
 * KiCad's own generator string, which is the deliberate one-way door out of
 * drafting mode: the edit guard lifts and the legibility finish gate stops
 * applying, because the drawing is no longer the engine's to defend.
 */
export function isEngineAuthoredSchematic(text: string): boolean {
  return text.slice(0, 400).includes(DRAFT_GENERATOR_MARKER);
}

/**
 * True when `.copperhead/config.json` marks the repo as create-produced.
 * Accepts the raw parsed object (or a loaded config that retained `origin`).
 */
export function isCreateProducedRepo(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return false;
  return (config as { origin?: unknown }).origin === CREATE_ORIGIN;
}

/**
 * Body of `## Draft quality` through the next `##` heading, or `null` if the
 * heading is absent. HTML comments and whitespace alone do not count as filled
 * (init scaffolds the empty heading + a placeholder comment).
 */
/**
 * The Draft quality heading, with or without the numbering a LAYOUT.md whose
 * other headings are numbered carries (`## 4. Draft quality`, `## 4) Draft
 * quality`, `## 4.1 Draft quality`), in any letter case (#327). One matcher
 * for the fab gate and the create stage gate.
 */
const DRAFT_QUALITY_HEADING_RE = /^##\s+(?:(?:\d+[.)]|\d+(?:\.\d+)+[.)]?)\s+)?Draft quality\s*$/i;
export function isDraftQualityHeading(line: string): boolean {
  return DRAFT_QUALITY_HEADING_RE.test(line.trim());
}

export function draftQualitySection(layoutMd: string): string | null {
  const lines = layoutMd.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isDraftQualityHeading(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;

  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s/.test(line.trim())) break;
    body.push(line);
  }
  return body.join('\n');
}

export function isFilledDraftQuality(sectionBody: string): boolean {
  const withoutComments = sectionBody.replace(/<!--[\s\S]*?-->/g, '');
  return withoutComments.trim().length > 0;
}

export interface DocumentationPresenceInput {
  /** Full LAYOUT.md text, or `null` when the file is missing. */
  layoutMd: string | null;
  /** Whether docs/DEVPLAN.md exists on disk. */
  devplanExists: boolean;
  /** From {@link isCreateProducedRepo}; only create repos require DEVPLAN.md. */
  isCreateRepo: boolean;
  /** Docs directory name used in violation locations (default `docs`). */
  docsDir?: string;
}

/**
 * Documentation-presence check for `check --fab` (task 1.5):
 * - LAYOUT.md must have a filled `## Draft quality` section
 * - create-produced repos must also have DEVPLAN.md
 *
 * Failures use the drift-report voice: file as location, claim `"release-ready"`.
 */
export function checkDocumentationPresence(input: DocumentationPresenceInput): FabCheckResult {
  const docs = (input.docsDir ?? 'docs').replace(/[/\\]+$/, '');
  const violations: FabViolation[] = [];
  const layoutLoc = `${docs}/LAYOUT.md`;
  const claim = 'release-ready';

  if (input.layoutMd === null) {
    violations.push({
      claim,
      actual: 'LAYOUT.md missing',
      location: layoutLoc,
    });
  } else {
    const section = draftQualitySection(input.layoutMd);
    if (section === null) {
      violations.push({
        claim,
        actual: `missing ${DRAFT_QUALITY_HEADING} section`,
        location: layoutLoc,
      });
    } else if (!isFilledDraftQuality(section)) {
      violations.push({
        claim,
        actual: `${DRAFT_QUALITY_HEADING} section is empty`,
        location: layoutLoc,
      });
    }
  }

  if (input.isCreateRepo && !input.devplanExists) {
    violations.push({
      claim,
      actual: 'missing',
      location: `${docs}/DEVPLAN.md`,
    });
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    violations,
  };
}

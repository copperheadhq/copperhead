/**
 * Fab release gate checks (OpenSpec: add-fab-release-gate).
 * Every check is local and deterministic: LLM-free and network-free.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import type { CopperheadConfig } from '../config.js';
import { configPath } from '../config.js';
import type { CheckReport, Violation } from './report.js';
import { listBoardFootprints, listSymbols } from './sexp.js';
import { parseBomTable, normalizeFootprint } from '../memory/bom-table.js';

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

export interface FabReport {
  routing: FabCheckResult;
  bom: FabCheckResult;
  schPcbMatch: FabCheckResult;
  outputs: FabCheckResult;
  docs: FabCheckResult;
}

export interface FabGateOptions {
  strict?: boolean;
  /** Export preflight cannot require artifacts which it has not generated yet. */
  skipOutputs?: boolean;
  /** DEVPLAN is produced after create's outputs stage. */
  skipDevplan?: boolean;
}

const pass = (): FabCheckResult => ({ status: 'pass', violations: [] });

function failOrWarn(violations: FabViolation[], warn: boolean): FabCheckResult {
  return { status: violations.length ? (warn ? 'warn' : 'fail') : 'pass', violations };
}

function unconnectedLocation(v: Violation): string | undefined {
  const item = v.items.find((i) => i.x !== undefined && i.y !== undefined);
  return item ? `(${item.x}, ${item.y})` : undefined;
}

function unconnectedName(v: Violation): string {
  const text = [v.description, ...v.items.map((i) => i.description)].join(' ');
  return /\[([^\]]+)\]/.exec(text)?.[1] ?? /net\s+['"]?([^'",;]+)/i.exec(text)?.[1]?.trim() ?? 'unknown net';
}

export function checkRoutingCompleteness(drc: CheckReport | null): FabCheckResult {
  if (!drc) return failOrWarn([{ claim: 'fully routed', actual: 'no PCB DRC report available' }], false);
  if (!(drc.unrouted ?? 0)) return pass();
  const items = drc.unconnected ?? [];
  const violations = items.length
    ? items.map((v) => ({
        claim: 'fully routed',
        actual: `unrouted connection on ${unconnectedName(v)}`,
        ...(unconnectedLocation(v) ? { location: unconnectedLocation(v) } : {}),
      }))
    : [{ claim: 'fully routed', actual: `${drc.unrouted} unrouted connection(s)` }];
  return failOrWarn(violations, false);
}

export function checkBomReadiness(bomMd: string | null, strict = false): FabCheckResult {
  if (bomMd === null) return failOrWarn([{ claim: 'orderable BOM', actual: 'BOM.md missing' }], false);
  const failures: FabViolation[] = [];
  const warnings: FabViolation[] = [];
  const rows = parseBomTable(bomMd);
  if (!rows.length) failures.push({ claim: 'orderable BOM', actual: 'no BOM rows found', location: 'BOM.md' });
  for (const row of rows) {
    if (!row.mpn || row.flags.includes('MISSING_MPN')) {
      failures.push({ claim: 'orderable BOM', actual: `${row.refdes} has no MPN`, location: 'BOM.md' });
    }
    if (!row.footprint?.trim()) {
      failures.push({ claim: 'orderable BOM', actual: `${row.refdes} has no footprint`, location: 'BOM.md' });
    }
    if (row.flags.includes('UNVERIFIED')) {
      warnings.push({ claim: 'verified sourcing', actual: `${row.refdes} is UNVERIFIED`, location: 'BOM.md' });
    }
  }
  const violations = [...failures, ...warnings];
  return { status: failures.length || (strict && warnings.length) ? 'fail' : warnings.length ? 'warn' : 'pass', violations };
}

export async function checkSchematicPcbMatch(
  schematicPath: string | null,
  boardPath: string | null,
): Promise<FabCheckResult> {
  if (!schematicPath || !boardPath) {
    return failOrWarn([{ claim: 'schematic/PCB parity', actual: 'schematic or PCB is not configured' }], false);
  }
  if (!existsSync(schematicPath) || !existsSync(boardPath)) {
    return failOrWarn([{ claim: 'schematic/PCB parity', actual: 'schematic or PCB file is missing' }], false);
  }
  const sch = new Map((await listSymbols(schematicPath)).map((s) => [s.ref, s.footprint]));
  const pcbRows = await listBoardFootprints(boardPath);
  const pcb = new Map(pcbRows.map((f) => [f.ref, f.footprint]));
  const violations: FabViolation[] = [];
  for (const [ref, footprint] of sch) {
    if (!pcb.has(ref)) {
      violations.push({ claim: 'schematic/PCB parity', actual: `${ref} present in schematic, absent from PCB`, location: ref });
    } else if (normalizeFootprint(footprint) !== normalizeFootprint(pcb.get(ref))) {
      violations.push({
        claim: 'schematic/PCB parity',
        actual: `${ref} footprint is ${pcb.get(ref) || '(none)'} on PCB, ${footprint || '(none)'} in schematic`,
        location: ref,
      });
    }
  }
  for (const { ref } of pcbRows) {
    if (!sch.has(ref)) violations.push({ claim: 'schematic/PCB parity', actual: `${ref} present on PCB, absent from schematic`, location: ref });
  }
  return failOrWarn(violations, false);
}

const GERBER_RE = /\.(?:gbr|gtl|gbl|gts|gbs|gto|gbo|gml)$/i;
const DRILL_RE = /\.drl$/i;

export async function checkOutputFreshness(
  repoRoot: string,
  config: CopperheadConfig,
): Promise<FabCheckResult> {
  const hint = 'run `copperhead create` to regenerate outputs';
  if (!config.board || !existsSync(path.join(repoRoot, config.board))) {
    return failOrWarn([{ claim: 'current fabrication outputs', actual: `board missing; ${hint}` }], false);
  }
  const record = config.fabOutputs;
  if (!record) {
    return failOrWarn([{ claim: 'current fabrication outputs', actual: `export provenance missing; ${hint}` }], false);
  }
  const missing = record.files.filter((file) => !existsSync(path.join(repoRoot, file)));
  const hasGerber = record.files.some((f) => GERBER_RE.test(f) && existsSync(path.join(repoRoot, f)));
  const hasDrill = record.files.some((f) => DRILL_RE.test(f) && existsSync(path.join(repoRoot, f)));
  const violations: FabViolation[] = [];
  if (!hasGerber) violations.push({ claim: 'current fabrication outputs', actual: `Gerber package missing; ${hint}`, location: 'outputs/' });
  if (!hasDrill) violations.push({ claim: 'current fabrication outputs', actual: `drill package missing; ${hint}`, location: 'outputs/' });
  for (const file of missing) violations.push({ claim: 'current fabrication outputs', actual: `recorded output missing; ${hint}`, location: file });
  const hash = createHash('sha256').update(await readFile(path.join(repoRoot, config.board))).digest('hex');
  if (hash !== record.boardSha256) {
    violations.push({ claim: 'current fabrication outputs', actual: `outputs are stale; ${hint}`, location: config.board });
  }
  return failOrWarn(violations, false);
}

async function filesBelow(root: string, dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await filesBelow(root, abs));
    else if (e.isFile()) out.push(path.relative(root, abs));
  }
  return out.sort();
}

/** Record a successful export against the exact board bytes that produced it. */
export async function recordFabOutputs(repoRoot: string, config: CopperheadConfig, outDir = 'outputs'): Promise<void> {
  if (!config.board) throw new Error('cannot record fabrication outputs without a configured board');
  const file = configPath(repoRoot);
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  raw.fabOutputs = {
    boardSha256: createHash('sha256').update(await readFile(path.join(repoRoot, config.board))).digest('hex'),
    files: await filesBelow(repoRoot, path.join(repoRoot, outDir)),
    generatedAt: new Date().toISOString(),
  };
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

export async function runFabGate(
  repoRoot: string,
  config: CopperheadConfig,
  drc: CheckReport | null,
  options: FabGateOptions = {},
): Promise<FabReport> {
  const docsDir = config.docs.replace(/[/\\]+$/, '');
  const bomPath = path.join(repoRoot, docsDir, 'BOM.md');
  const layoutPath = path.join(repoRoot, docsDir, 'LAYOUT.md');
  const layoutMd = existsSync(layoutPath) ? await readFile(layoutPath, 'utf8') : null;
  return {
    routing: checkRoutingCompleteness(drc),
    bom: checkBomReadiness(existsSync(bomPath) ? await readFile(bomPath, 'utf8') : null, options.strict),
    schPcbMatch: await checkSchematicPcbMatch(
      config.schematic ? path.join(repoRoot, config.schematic) : null,
      config.board ? path.join(repoRoot, config.board) : null,
    ),
    outputs: options.skipOutputs ? pass() : await checkOutputFreshness(repoRoot, config),
    docs: checkDocumentationPresence({
      layoutMd,
      devplanExists: options.skipDevplan || existsSync(path.join(repoRoot, docsDir, 'DEVPLAN.md')),
      isCreateRepo: isCreateProducedRepo(config),
      docsDir,
    }),
  };
}

export function fabReportOk(report: FabReport): boolean {
  return Object.values(report).every((r) => r.status !== 'fail');
}

export function formatFabReport(report: FabReport): string {
  const labels: Record<keyof FabReport, string> = {
    routing: 'routing', bom: 'BOM', schPcbMatch: 'schematic/PCB', outputs: 'outputs', docs: 'docs',
  };
  const lines: string[] = [];
  for (const key of Object.keys(labels) as (keyof FabReport)[]) {
    const result = report[key];
    const mark = result.status === 'pass' ? '✓' : result.status === 'warn' ? '⚠' : '✗';
    lines.push(`fab ${labels[key]} ${mark}`);
    for (const v of result.violations) lines.push(`  ${v.claim}: ${v.actual}${v.location ? ` (${v.location})` : ''}`);
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

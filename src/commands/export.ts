import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { checkDrift } from '../memory/drift.js';
import { buildExport, parseBom, SUPPLIERS, isSupplier, type Supplier, type ExportResult } from '../kicad/bom-export.js';
import { draftSchematicToText, defaultIntentPath } from '../kicad/draft/draft.js';
import { buildCircuitJson, serializeCircuitJson } from '../kicad/draft/circuit-json.js';

/**
 * `copperhead export bom` (capability supplier-bom-export): deterministic,
 * LLM-free, network-free — safe anywhere `check` is safe. This module must never
 * import a provider.
 */
export class ExportError extends Error {}

export interface ExportBomOptions {
  repoRoot: string;
  supplier: Supplier;
  boards: number;
  spares: number;
  includeUnverified: boolean;
}

export interface ExportBomResult extends ExportResult {
  supplier: Supplier;
  /** Repo-relative path the CSV was written to. */
  outPath: string;
}

const OUT_DIR = 'outputs';

export function outFileFor(supplier: Supplier): string {
  return path.join(OUT_DIR, `${supplier}-bom.csv`);
}

/**
 * Read BOM.md, refuse on drift, and write the supplier CSV to
 * outputs/<supplier>-bom.csv. Throws ExportError with an actionable message for
 * the caller to print and exit non-zero.
 */
export async function runExportBom(opts: ExportBomOptions): Promise<ExportBomResult> {
  const config = await loadConfig(opts.repoRoot);
  const bomPath = path.join(opts.repoRoot, config.docs, 'BOM.md');
  if (!existsSync(bomPath)) {
    throw new ExportError(
      `no ${path.join(config.docs, 'BOM.md')} to export — run copperhead init on an existing project, or copperhead create`,
    );
  }

  // BOM.md is the sole input, but it must agree with the schematic before it can
  // be trusted as an ordering source (requirement "BOM.md is the sole input").
  // Refuse loudly here rather than let a drifted BOM become a wrong order.
  if (config.schematic && existsSync(path.join(opts.repoRoot, config.schematic))) {
    const drift = await checkDrift(opts.repoRoot, config.docs, config.schematic);
    if (drift.length) {
      const lines = drift.map((m) => `  - ${m.doc} claims "${m.claim}" but actual is "${m.actual}"`).join('\n');
      throw new ExportError(
        `BOM.md drifts from the schematic; run \`copperhead check\` and resolve drift before ordering:\n${lines}`,
      );
    }
  }

  const rows = parseBom(await readFile(bomPath, 'utf8'));
  const result = buildExport(rows, opts.supplier, {
    boards: opts.boards,
    spares: opts.spares,
    includeUnverified: opts.includeUnverified,
  });

  const outPath = outFileFor(opts.supplier);
  await mkdir(path.join(opts.repoRoot, OUT_DIR), { recursive: true });
  await writeFile(path.join(opts.repoRoot, outPath), result.csv, 'utf8');

  return { ...result, supplier: opts.supplier, outPath };
}

/**
 * Deterministically emit the JLCPCB assembly BOM alongside the create stage-6
 * outputs (create-pipeline delta). No-op when there is no BOM.md yet; never
 * throws on drift here — the pipeline's own gates own that.
 */
export async function emitCreateJlcpcbBom(repoRoot: string): Promise<string | null> {
  const config = await loadConfig(repoRoot);
  const bomPath = path.join(repoRoot, config.docs, 'BOM.md');
  if (!existsSync(bomPath)) return null;
  const rows = parseBom(await readFile(bomPath, 'utf8'));
  const { csv } = buildExport(rows, 'jlcpcb', { boards: 1, spares: 10, includeUnverified: false });
  const outPath = outFileFor('jlcpcb');
  await mkdir(path.join(repoRoot, OUT_DIR), { recursive: true });
  await writeFile(path.join(repoRoot, outPath), csv, 'utf8');
  return outPath;
}

export interface ExportCircuitJsonOptions {
  repoRoot: string;
  /** Repo-relative output path; defaults to `outputs/circuit.json`. */
  out?: string;
}

export interface ExportCircuitJsonResult {
  outPath: string;
  elementCount: number;
}

/**
 * `copperhead export circuit-json` (capability circuit-json-export): a derived
 * read-only circuit-json view of a DRAFTED schematic. Same contract as
 * `export bom`: deterministic, LLM-free, network-free. Drafted sheets only —
 * re-drafts the intent and refuses unless the result byte-matches the on-disk
 * schematic, so the export always depicts the sheet as drawn, never a lift of
 * hand-edited KiCad text (issue #178: circuit-json is only ever a derived view).
 *
 * There is exactly ONE circuit-json build, from the intent plus the engine's
 * placement model; the `.kicad_sch` is never parsed into circuit-json, so the
 * gate is NOT two circuit-jsons compared. The re-draft's KiCad text equalling
 * the on-disk sheet byte-for-byte is what licenses the single serialization to
 * claim it depicts the drawn schematic: both backends (KiCad text, circuit-json)
 * are pure functions of the same lowered model, so text equality transfers the
 * claim without a second lift path existing at all.
 */
export async function runExportCircuitJson(opts: ExportCircuitJsonOptions): Promise<ExportCircuitJsonResult> {
  const config = await loadConfig(opts.repoRoot);
  if (!config.schematic || !existsSync(path.join(opts.repoRoot, config.schematic))) {
    throw new ExportError('no schematic configured in .copperhead/config.json — run copperhead init or create first');
  }
  const intentRel = defaultIntentPath(config.schematic);
  if (!existsSync(path.join(opts.repoRoot, intentRel))) {
    throw new ExportError(
      `no ${intentRel} — circuit-json export covers copperhead-drafted schematics only ` +
        '(the intent IR plus the engine placement are its inputs); draft the sheet with copperhead draft or create',
    );
  }

  const onDisk = await readFile(path.join(opts.repoRoot, config.schematic), 'utf8');
  // Re-draft with the sheet's own title-block date so a sheet drafted on an
  // earlier day still compares equal (the engine takes the date as an input
  // precisely so identical IR emits identical bytes on any day).
  const dateOnSheet = /\(date "([^"]*)"\)/.exec(onDisk)?.[1];
  const res = await draftSchematicToText({
    repoRoot: opts.repoRoot,
    schematic: config.schematic,
    intentPath: intentRel,
    docsDir: config.docs,
    ...(dateOnSheet ? { today: dateOnSheet } : {}),
  });
  if (!res.ok) {
    throw new ExportError(`intent does not validate; fix ${intentRel} and re-draft:\n${res.message}`);
  }
  if (res.text !== onDisk) {
    throw new ExportError(
      `${config.schematic} does not match what ${intentRel} drafts — the sheet is stale or was edited outside the ` +
        'draft pipeline; re-draft with copperhead draft schematic, then export again',
    );
  }

  const elements = buildCircuitJson(res.validated, res.model);
  const outPath = opts.out ?? path.join(OUT_DIR, 'circuit.json');
  await mkdir(path.dirname(path.join(opts.repoRoot, outPath)), { recursive: true });
  await writeFile(path.join(opts.repoRoot, outPath), serializeCircuitJson(elements), 'utf8');
  return { outPath, elementCount: elements.length };
}

/** Validate `--supplier`; throws ExportError listing the supported values. */
export function parseSupplier(value: string): Supplier {
  if (!isSupplier(value)) {
    throw new ExportError(`unknown supplier "${value}"; supported: ${SUPPLIERS.join(', ')}`);
  }
  return value;
}

/** Validate `--boards`: a positive integer. */
export function parseBoards(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new ExportError(`--boards must be a positive integer, got "${value}"`);
  }
  return n;
}

/** Validate `--spares`: a non-negative percentage. */
export function parseSpares(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ExportError(`--spares must be a non-negative number, got "${value}"`);
  }
  return n;
}

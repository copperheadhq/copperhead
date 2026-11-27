import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { checkDrift } from '../memory/drift.js';
import { buildExport, parseBom, SUPPLIERS, isSupplier, type Supplier, type ExportResult } from '../kicad/bom-export.js';

/**
 * `copperhead export bom` (capability supplier-bom-export): deterministic,
 * LLM-free, network-free — safe anywhere `check` is safe. This module must never
 * import a provider.
 */
import { ExportError } from '../util/errors.js';
export { ExportError };

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

export {
  runExportFirmware,
  parseFirmwareTarget,
  DEFAULT_FIRMWARE_HEADER,
  FIRMWARE_TARGETS,
  type FirmwareTarget,
  type ExportFirmwareOptions,
  type ExportFirmwareResult,
} from '../kicad/firmware.js';

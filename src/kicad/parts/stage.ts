/**
 * The parts manifest as the create pipeline sees it (design D2, D8): one
 * function that reads `docs/parts.intent.json`, validates it against this
 * machine's libraries, renders BOM.md in memory and says whether the file on
 * disk is that render. `draft_bom`, the stage-3 completion predicate, the
 * finish-time stage gate and the contract-gap message all call it, so they
 * cannot disagree. No manifest → null, and every caller keeps its
 * pre-manifest behaviour.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SymbolSource } from '../draft/symsource.js';
import { FootprintResolver } from '../footprints.js';
import { libraryCache } from '../cache.js';
import { MANIFEST_FILENAME, parseManifest, type ManifestFinding, type PartsManifest } from './manifest.js';
import { renderManifest } from './render.js';
import { formatManifestFindings, validatePartsManifest, type ManifestValidation } from './validate.js';

export interface PartsCheck {
  /** Repo-relative manifest path. */
  manifestPath: string;
  /** Null when the file is not even the right shape; `shapeFindings` say why. */
  manifest: PartsManifest | null;
  shapeFindings: ManifestFinding[];
  validation: ManifestValidation | null;
  /** BOM.md as the manifest renders, when the manifest parsed. */
  rendered: string | null;
  /** BOM.md on disk equals `rendered` (line endings and trailing whitespace aside). */
  bomMatches: boolean;
}

export interface PartsCheckConfig {
  docs: string;
  schematic: string | null;
  board: string | null;
}

export interface PartsCheckOptions {
  /** Symbol library directories (tests); defaults to the machine's. */
  symbolDirs?: string[];
  /** A prepared resolver (tests, or a caller that already has one). */
  footprints?: FootprintResolver;
  maxFindings?: number;
}

const canon = (s: string): string => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');

export function partsManifestPath(docs: string): string {
  return path.join(docs, MANIFEST_FILENAME);
}

/** Validate the repo's manifest, or null when there is none. */
export async function checkPartsManifest(repoRoot: string, config: PartsCheckConfig, opts: PartsCheckOptions = {}): Promise<PartsCheck | null> {
  const manifestRel = partsManifestPath(config.docs);
  const manifestAbs = path.join(repoRoot, manifestRel);
  if (!existsSync(manifestAbs)) return null;
  libraryCache.attach(repoRoot);
  const { manifest, findings: shapeFindings } = parseManifest(await readFile(manifestAbs, 'utf8'));
  const out: PartsCheck = { manifestPath: manifestRel, manifest, shapeFindings, validation: null, rendered: null, bomMatches: false };
  if (!manifest) return out;
  const anchor = config.board ?? config.schematic;
  const projectDir = anchor ? path.dirname(path.join(repoRoot, anchor)) : repoRoot;
  // vendor=false: stage 3 has no schematic to vendor symbols for, and a
  // validation must not write into the sym-lib cache
  const symbols = new SymbolSource(repoRoot, opts.symbolDirs, false, projectDir);
  const footprints = opts.footprints ?? (await FootprintResolver.create({ projectDir }));
  const subsystemsPath = path.join(repoRoot, config.docs, 'SUBSYSTEMS.md');
  const subsystemsMd = existsSync(subsystemsPath) ? await readFile(subsystemsPath, 'utf8') : null;
  out.validation = await validatePartsManifest(manifest, { symbols, footprints, subsystemsMd, ...(opts.maxFindings !== undefined ? { maxFindings: opts.maxFindings } : {}) });
  out.rendered = renderManifest(manifest);
  const bomAbs = path.join(repoRoot, config.docs, 'BOM.md');
  out.bomMatches = existsSync(bomAbs) && canon(await readFile(bomAbs, 'utf8')) === canon(out.rendered);
  return out;
}

/** The stage-3 contract: a manifest that validates clean and a BOM.md that is its render. */
export function partsStageComplete(check: PartsCheck | null): boolean {
  return !!check?.validation?.ok && check.bomMatches;
}

/**
 * What stands between this manifest and a complete stage, for the model:
 * shape findings, validator findings, or a BOM.md that is not the render.
 * Null when complete. Library stops are not the model's gap (they are the
 * user's) and are listed as notes only.
 */
export function partsStageGap(check: PartsCheck | null): string | null {
  if (!check) return null;
  if (!check.manifest) return `${check.manifestPath} is not a valid parts manifest:\n${check.shapeFindings.map((f) => `  - ${f.detail}`).join('\n')}`;
  const v = check.validation!;
  // formatManifestFindings opens with the count, so the path alone introduces it.
  if (!v.ok) return `${check.manifestPath}: ${formatManifestFindings(v)}`;
  if (!check.bomMatches) return `BOM.md is not the render of ${check.manifestPath}; call draft_bom to render it`;
  return null;
}

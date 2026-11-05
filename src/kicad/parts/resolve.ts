/**
 * The manifest's entries with a passive's ids derived from its package (design
 * D3) and nothing else: no library is consulted. What the renderer, the drift
 * comparison, the IR validator and the dossier read; `validate.ts` builds on
 * it. Kept free of imports from the draft engine so `ir.ts` can import it
 * without a cycle.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FILENAME, parseManifest, refPrefix, type ManifestFinding, type PartsManifest } from './manifest.js';
import { isPassivePrefix, passiveDefault } from './passives.js';

/** A manifest entry with its derived ids filled in. */
export interface ResolvedPart {
  ref: string;
  value: string;
  group: string;
  libId: string | null;
  footprint: string | null;
  mpn: string | null;
  rationale: string | null;
  verified: boolean;
  offBoard: boolean;
  noPart: boolean;
}

export function resolveParts(manifest: PartsManifest): ResolvedPart[] {
  return manifest.parts.map((e) => {
    const prefix = refPrefix(e.ref);
    const part: ResolvedPart = {
      ref: e.ref,
      value: e.value,
      group: e.group ?? '',
      libId: e.libId ?? null,
      footprint: e.footprint ?? null,
      mpn: e.mpn ?? null,
      rationale: e.rationale ?? null,
      verified: e.verified === true,
      offBoard: e.offBoard === true,
      noPart: e.noPart === true,
    };
    if (!part.offBoard && isPassivePrefix(prefix) && e.package && (!part.libId || !part.footprint)) {
      const d = passiveDefault(prefix, e.package);
      if (d) {
        part.libId ??= d.libId;
        part.footprint ??= d.footprint;
      }
    }
    return part;
  });
}

export const manifestPath = (docsDir: string): string => path.join(docsDir, MANIFEST_FILENAME);

/**
 * The manifest in `docsDir`, with the three states kept apart. A file that is
 * there but not a manifest is not "no manifest": a reader that fell back to its
 * pre-manifest behaviour on it would stop enforcing the manifest exactly when
 * the manifest broke.
 */
export type LoadedManifest =
  | { state: 'absent' }
  | { state: 'invalid'; findings: ManifestFinding[] }
  | { state: 'ok'; manifest: PartsManifest };

export async function loadManifest(docsDir: string): Promise<LoadedManifest> {
  const file = manifestPath(docsDir);
  if (!existsSync(file)) return { state: 'absent' };
  const { manifest, findings } = parseManifest(await readFile(file, 'utf8'));
  return manifest ? { state: 'ok', manifest } : { state: 'invalid', findings };
}

/** One line saying why the file is not a manifest, for a reader that must report it. */
export function invalidManifestDetail(findings: ManifestFinding[]): string {
  const first = findings[0]?.detail ?? 'not a valid parts manifest';
  return findings.length > 1 ? `${first} (and ${findings.length - 1} more)` : first;
}

/**
 * The manifest in `docsDir`, or null when absent or unparseable. For readers
 * that only use the manifest as a convenience (the pin dossier); a reader that
 * enforces it uses `loadManifest` so a broken file is reported, not skipped.
 */
export async function readManifest(docsDir: string): Promise<PartsManifest | null> {
  const m = await loadManifest(docsDir);
  return m.state === 'ok' ? m.manifest : null;
}

/** Resolved manifest parts by refdes, or null when there is no manifest. Throws nothing: use `loadManifest` to tell an invalid file apart. */
export async function manifestPartsOf(docsDir: string): Promise<Map<string, ResolvedPart> | null> {
  const m = await readManifest(docsDir);
  return m ? new Map(resolveParts(m).map((p) => [p.ref, p])) : null;
}

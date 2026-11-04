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
import { MANIFEST_FILENAME, parseManifest, refPrefix, type PartsManifest } from './manifest.js';
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

/** The manifest in `docsDir`, parsed, or null when absent or unparseable. */
export async function readManifest(docsDir: string): Promise<PartsManifest | null> {
  const file = manifestPath(docsDir);
  if (!existsSync(file)) return null;
  return parseManifest(await readFile(file, 'utf8')).manifest;
}

/** Resolved manifest parts by refdes, or null when there is no manifest. */
export async function manifestPartsOf(docsDir: string): Promise<Map<string, ResolvedPart> | null> {
  const m = await readManifest(docsDir);
  return m ? new Map(resolveParts(m).map((p) => [p.ref, p])) : null;
}

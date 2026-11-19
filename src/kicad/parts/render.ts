/**
 * BOM.md rendered from the parts manifest (design D1, D7): the human document
 * stays, as an output. Deterministic: the same manifest renders the same
 * bytes, which is what lets drift compare the file with its render.
 *
 * Column order keeps the canonical five first (Refdes | Value | Footprint |
 * MPN | Rationale) so every positional fallback in the existing readers still
 * lands on the right cell; Symbol is appended.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OFF_BOARD_MARKER, NO_PART_MARKER, parseBomTable, normalizeValue, normalizeFootprint } from '../../memory/bom-table.js';
import { MANIFEST_FILENAME, type PartsManifest, type Substitution } from './manifest.js';
import { resolveParts, loadManifest, invalidManifestDetail, type ResolvedPart } from './resolve.js';

export { readManifest, manifestPath } from './resolve.js';

export const RENDER_HEADER = `<!-- rendered from ${MANIFEST_FILENAME} by copperhead draft_bom; edit the manifest, not this table -->`;

/** A cell with the table's own delimiters neutralised. */
const cell = (s: string | null | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

export function renderBom(parts: ResolvedPart[], substitutions: Substitution[] = []): string {
  const lines = ['# BOM', '', RENDER_HEADER, '', '| Refdes | Value | Footprint | MPN | Rationale | Symbol |', '| --- | --- | --- | --- | --- | --- |'];
  for (const p of parts) {
    const footprint = p.offBoard ? OFF_BOARD_MARKER : cell(p.footprint);
    const mpn = p.noPart ? NO_PART_MARKER : p.mpn ? (p.verified ? cell(p.mpn) : `${cell(p.mpn)} (UNVERIFIED)`) : '';
    const symbol = p.offBoard ? '' : cell(p.libId);
    lines.push(`| ${cell(p.ref)} | ${cell(p.value)} | ${footprint} | ${mpn} | ${cell(p.rationale)} | ${symbol} |`);
  }
  if (substitutions.length) {
    lines.push('', '## Substitutions', '', '| Part | Wanted | Chosen | Reason |', '| --- | --- | --- | --- |');
    for (const s of substitutions) lines.push(`| ${cell(s.ref)} | ${cell(s.wanted)} | ${cell(s.chosen)} | ${cell(s.reason)} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderManifest(manifest: PartsManifest): string {
  return renderBom(resolveParts(manifest), manifest.substitutions ?? []);
}

/** Line-ending and trailing-whitespace insensitive equality for the drift comparison. */
const canon = (s: string): string => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');

/**
 * Where BOM.md differs from its manifest's render, as drift mismatches (doc,
 * claim, actual): one per refdes whose value, footprint or MPN cell differs,
 * a row the render lacks or the file lacks, and a single generic mismatch when
 * only prose outside the table changed. Empty when there is no manifest, or
 * the file is its render. A manifest file that does not parse is itself a
 * mismatch: silence there would let `check` pass on the old BOM.md while the
 * manifest it is supposed to be rendered from is broken.
 */
export async function manifestDrift(docsDir: string): Promise<{ doc: string; claim: string; actual: string }[]> {
  const loaded = await loadManifest(docsDir);
  if (loaded.state === 'absent') return [];
  if (loaded.state === 'invalid') {
    return [{ doc: MANIFEST_FILENAME, claim: 'is a valid parts manifest', actual: `${invalidManifestDetail(loaded.findings)}; fix it and run draft_bom` }];
  }
  const manifest = loaded.manifest;
  const bomPath = path.join(docsDir, 'BOM.md');
  const rendered = renderManifest(manifest);
  if (!existsSync(bomPath)) return [{ doc: 'BOM.md', claim: 'absent', actual: `${MANIFEST_FILENAME} lists ${manifest.parts.length} part(s); run draft_bom to render it` }];
  const text = await readFile(bomPath, 'utf8');
  if (canon(text) === canon(rendered)) return [];
  const out: { doc: string; claim: string; actual: string }[] = [];
  const have = new Map(parseBomTable(text).map((r) => [r.refdes, r]));
  const want = new Map(parseBomTable(rendered).map((r) => [r.refdes, r]));
  for (const [ref, w] of want) {
    const h = have.get(ref);
    if (!h) {
      out.push({ doc: 'BOM.md', claim: `${ref} absent`, actual: `${ref} (${w.value ?? ''}) in ${MANIFEST_FILENAME}` });
      continue;
    }
    if (normalizeValue(h.value) !== normalizeValue(w.value)) out.push({ doc: 'BOM.md', claim: `${ref} value ${h.value ?? ''}`, actual: `${ref} value ${w.value ?? ''} in ${MANIFEST_FILENAME}` });
    if (normalizeFootprint(h.footprint) !== normalizeFootprint(w.footprint)) out.push({ doc: 'BOM.md', claim: `${ref} footprint ${h.footprint ?? ''}`, actual: `${ref} footprint ${w.footprint ?? ''} in ${MANIFEST_FILENAME}` });
    if (normalizeValue(h.mpn) !== normalizeValue(w.mpn)) out.push({ doc: 'BOM.md', claim: `${ref} MPN ${h.mpn ?? ''}`, actual: `${ref} MPN ${w.mpn ?? ''} in ${MANIFEST_FILENAME}` });
  }
  for (const ref of have.keys()) {
    if (!want.has(ref)) out.push({ doc: 'BOM.md', claim: `${ref} exists`, actual: `${ref} not in ${MANIFEST_FILENAME}` });
  }
  if (!out.length) out.push({ doc: 'BOM.md', claim: 'is its manifest render', actual: `differs from the render of ${MANIFEST_FILENAME} outside the table; run draft_bom to re-render it` });
  return out;
}

/**
 * Deterministic BOM.md generator (Issue #459).
 *
 * Renders validated parts manifest data into canonical Markdown.
 * Pure and idempotent: stable LF output, deterministic natural refdes sorting,
 * proper cell escaping, and explicit UNVERIFIED flags.
 */

import { compareRefdes, type ExpandedPart, type SubstitutionEntry } from './manifest.js';

export function escapeCell(text: string | undefined): string {
  if (!text) return '-';
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim() || '-';
}

export function renderBomMarkdown(
  parts: ExpandedPart[],
  substitutions: SubstitutionEntry[] = [],
): string {
  const sortedParts = [...parts].sort((a, b) => compareRefdes(a.ref, b.ref));

  const lines: string[] = [
    '# Bill of Materials',
    '',
    '<!-- Generated deterministically from parts.intent.json by copperhead draft_bom. Do not hand-edit table. -->',
    '',
    '| Refdes | Value | Symbol | Footprint | MPN | Rationale |',
    '|---|---|---|---|---|---|',
  ];

  for (const part of sortedParts) {
    const ref = part.ref;
    const value = part.value;
    const symbol = part.offBoard ? '(off-board)' : part.libId;
    const footprint = part.offBoard ? '(off-board)' : part.footprint;

    let mpn = '-';
    if (part.mpn) {
      mpn = part.verified ? part.mpn : `UNVERIFIED ${part.mpn}`;
    }

    let rationale = part.rationale || '-';
    if (part.offBoard && !rationale.toLowerCase().includes('off-board')) {
      rationale = `(off-board) ${rationale}`;
    }

    lines.push(
      `| ${escapeCell(ref)} | ${escapeCell(value)} | ${escapeCell(symbol)} | ${escapeCell(footprint)} | ${escapeCell(mpn)} | ${escapeCell(rationale)} |`,
    );
  }

  if (substitutions && substitutions.length > 0) {
    const sortedSubs = [...substitutions].sort((a, b) => compareRefdes(a.ref, b.ref));
    lines.push(
      '',
      '## Substitutions',
      '',
      '| Refdes | Wanted | Chosen | Reason |',
      '|---|---|---|---|',
    );
    for (const sub of sortedSubs) {
      lines.push(
        `| ${escapeCell(sub.ref)} | ${escapeCell(sub.wanted)} | ${escapeCell(sub.chosen)} | ${escapeCell(sub.reason)} |`,
      );
    }
  }

  lines.push(''); // trailing newline
  return lines.join('\n');
}

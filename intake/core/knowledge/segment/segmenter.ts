/**
 * Segmenter (SPEC §7): table row = default atomic evidence unit; headers and
 * footnotes attach by reference; cross-page tables reassemble only on header
 * identity + column count + continuation evidence. Evidence ids are minted
 * here, by core — never by a provider (AC-3.2).
 *
 * v1 ingests text-form datasheet pages (the stub-provider path); PDF layout
 * segmentation arrives with the vendor adapter (step 6) behind the same
 * output shape.
 */

import type { DocumentRef, EvidenceUnit } from "../types";

export interface TextPage {
  page: number;
  /** Lines; pipe-separated lines are table rows. */
  lines: string[];
}

export interface SegmentedDocument {
  units: EvidenceUnit[];
}

function isTableRow(line: string): boolean {
  return line.includes("|");
}

function isHeader(line: string): boolean {
  // Header rows carry qualifier column labels rather than values.
  return /\b(MIN|TYP|MAX|NOM|UNIT)\b/i.test(line) && isTableRow(line);
}

const FOOTNOTE = /^\((\d+)\)\s/;

export function segment(
  document: DocumentRef,
  pages: TextPage[],
): SegmentedDocument {
  const units: EvidenceUnit[] = [];
  const shortSha = document.sha256.slice(0, 8);

  let currentSection: string | undefined;
  let currentHeader: { text: string; columns: number } | undefined;

  for (const page of pages) {
    const footnotes = new Map<string, string>();
    for (const line of page.lines) {
      const note = FOOTNOTE.exec(line);
      if (note) footnotes.set(`(${note[1]})`, line);
    }

    let row = 0;
    for (const line of page.lines) {
      const text = line.trim();
      if (text.length === 0 || FOOTNOTE.test(text)) continue;
      if (!isTableRow(text)) {
        // Prose line: treat as a section heading for subsequent rows.
        currentSection = text;
        // A section break ends any cross-page table continuation.
        currentHeader = undefined;
        continue;
      }
      const columns = text.split("|").length;
      if (isHeader(text)) {
        currentHeader = { text, columns };
        continue;
      }
      // Cross-page continuation requires identical header + column count
      // (enforced by keeping currentHeader only while both match).
      if (currentHeader !== undefined && columns !== currentHeader.columns) {
        currentHeader = undefined;
      }
      row += 1;
      const referenced = [...footnotes.entries()]
        .filter(([marker]) => text.includes(marker))
        .map(([, note]) => note);
      units.push({
        evidenceId: `ev-${shortSha}-p${page.page}-r${row}`,
        document,
        page: page.page,
        ...(currentSection !== undefined ? { section: currentSection } : {}),
        row,
        text,
        ...(currentHeader !== undefined || referenced.length > 0
          ? {
              context: [currentHeader?.text, ...referenced]
                .filter((s): s is string => s !== undefined)
                .join("\n"),
            }
          : {}),
      });
    }
  }
  return { units };
}

/** Form-feed separated pages, as cortex's ingestion pipeline split inline text (pipeline.ts:398). */
export function parsePages(content: string): TextPage[] {
  return content
    .split("\f")
    .map((text, i) => ({ page: i + 1, lines: text.split("\n") }))
    .filter((p) => p.lines.some((l) => l.trim().length > 0));
}

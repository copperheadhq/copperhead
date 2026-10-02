// Evidence units (ground-intake-extraction D3): the core mints one unit per line of every
// selected page. A table row under a header carries the header in its context and layout;
// a unit carries the text of the footnotes it references; the table lines around it are its
// neighbours. Ids are deterministic: ev-<first 8 hex of the document sha256>-p<page>-l<line>.
// Pure.

import type { DocumentRef } from "../knowledge/types";
import type { Cell, IntakeUnit, Line, SourcePage } from "./types";

const HEADER_WORDS = new Set([
  "MIN", "MINIMUM", "TYP", "TYPICAL", "MAX", "MAXIMUM", "NOM", "NOMINAL", "UNIT", "UNITS",
  "SYMBOL", "PARAMETER", "PARAMETERS", "VALUE", "CONDITIONS", "TEST CONDITIONS", "RATING", "RATINGS",
]);
const FOOTNOTE_DEF = /^\((\d{1,2})\)\s*(?:\|\s*)?(.+)$|^(\d{1,2})\.\s+(.+)$/;

export function isHeader(line: Line): boolean {
  if (line.cells.length < 2) return false;
  const hits = line.cells.filter((c) => HEADER_WORDS.has(c.text.trim().toUpperCase())).length;
  return hits >= 2;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function isHeading(line: Line, body: number): boolean {
  if (/^(table|figure)\s+\d+/i.test(line.text)) return true;
  if (line.fontSize > 0 && body > 0 && line.fontSize >= body + 1.5) return true;
  return /^[A-Z][A-Z \-]{4,}$/.test(line.text) && line.text.split(" ").length <= 6;
}

function footnoteDefinition(line: Line): { ref: string; text: string } | undefined {
  const m = FOOTNOTE_DEF.exec(line.text);
  if (!m) return undefined;
  return { ref: (m[1] ?? m[3]) as string, text: ((m[2] ?? m[4]) as string).replace(/\s*\|\s*/g, " ") };
}

/** Short hex prefix of the document hash used in unit ids. */
export function documentTag(document: DocumentRef): string {
  return document.sha256.slice(0, 8);
}

export function mintUnits(document: DocumentRef, pages: SourcePage[]): IntakeUnit[] {
  const units: IntakeUnit[] = [];
  let header: Line | undefined;
  // Footnote definitions across the document, with up to two continuation lines each. Numbering
  // restarts per table, so a reference resolves to the first definition after its line on the
  // same or the next page, and only failing that to the nearest one before it on its page.
  const definitions: { page: number; index: number; ref: string; text: string }[] = [];
  pages.forEach((page, p) => {
    const body = median(page.lines.map((l) => l.fontSize).filter((f) => f > 0));
    page.lines.forEach((line, i) => {
      const def = footnoteDefinition(line);
      if (!def) return;
      let text = def.text;
      for (let j = i + 1; j < Math.min(i + 3, page.lines.length); j++) {
        const next = page.lines[j]!;
        if (footnoteDefinition(next) || isHeading(next, body)) break;
        text += ` ${next.text}`;
      }
      definitions.push({ page: p, index: i, ref: def.ref, text });
    });
  });
  const footnoteFor = (p: number, i: number, ref: string): string | undefined => {
    const same = definitions.filter((d) => d.ref === ref);
    const after = same.find((d) => (d.page === p && d.index > i) || d.page === p + 1);
    if (after) return after.text;
    const before = same.filter((d) => d.page === p && d.index < i);
    return before[before.length - 1]?.text;
  };
  for (const [p, page] of pages.entries()) {
    const body = median(page.lines.map((l) => l.fontSize).filter((f) => f > 0));

    // Table membership: from a header line until a heading or a footnote definition. A header
    // carries to the next page only when that page repeats it.
    if (header && !page.lines.some((l) => isHeader(l) && l.text === header!.text)) header = undefined;
    let section: string | undefined;
    const tableOf: (Line | undefined)[] = [];
    for (const line of page.lines) {
      if (isHeader(line)) header = line;
      else if (isHeading(line, body) || footnoteDefinition(line)) header = undefined;
      tableOf.push(header);
    }

    page.lines.forEach((line, i) => {
      if (isHeading(line, body)) section = line.text.replace(/\s*\|\s*/g, " ");
      const table = tableOf[i];
      const inTable = table !== undefined && table !== line;
      const neighbors: string[] = [];
      if (inTable) {
        if (i > 0 && tableOf[i - 1] === table && page.lines[i - 1] !== table) neighbors.push(page.lines[i - 1]!.text);
        if (i + 1 < page.lines.length && tableOf[i + 1] === table) neighbors.push(page.lines[i + 1]!.text);
      }
      const refs = [...new Set(line.footnoteRefs)];
      const context = [
        ...(inTable ? [table!.text] : []),
        ...refs.flatMap((r) => {
          const text = footnoteFor(p, i, r);
          return text === undefined ? [] : [`(${r}) ${text}`];
        }),
      ].join("\n");
      const unit: IntakeUnit = {
        evidenceId: `ev-${documentTag(document)}-p${page.page}-l${i + 1}`,
        document,
        page: page.page,
        text: line.text,
        bbox: line.bbox,
        textSource: page.textSource,
        layout: inTable ? { cells: line.cells, header: table!.cells } : { cells: line.cells },
        footnoteRefs: refs,
        neighbors,
      };
      if (section !== undefined) unit.section = section;
      if (context !== "") unit.context = context;
      if (inTable) {
        unit.table = table!.text;
        unit.row = i + 1;
      }
      units.push(unit);
    });
  }
  return units;
}

/** The header cell above a unit cell, by horizontal overlap (text layer) or by index (OCR). */
export function headerCellFor(cell: Cell, header: Cell[]): Cell | undefined {
  if (cell.x0 === undefined || cell.x1 === undefined) return header.find((h) => h.index === cell.index);
  let best: Cell | undefined;
  let bestScore = -Infinity;
  const centre = (cell.x0 + cell.x1) / 2;
  for (const h of header) {
    if (h.x0 === undefined || h.x1 === undefined) continue;
    const overlap = Math.min(cell.x1, h.x1) - Math.max(cell.x0, h.x0);
    const score = overlap > 0 ? overlap : -Math.abs(centre - (h.x0 + h.x1) / 2);
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

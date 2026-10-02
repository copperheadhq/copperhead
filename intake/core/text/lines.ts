// Text-layer lines (ground-intake-extraction D2). Pure: the pdf.js adapter supplies the items.
//
// Items are grouped into lines by baseline. A smaller item within half the line's font size
// of its baseline is a subscript (merged into the text) or a superscript (a footnote marker,
// recorded as a reference and kept out of the text). Within a line, a gap wider than
// CELL_GAP_EM ems starts a new cell, so a table row arrives as cells joined by " | ".
// Thresholds were measured on the demo datasheets: word gaps reach 1.0 em only after a
// section number, justified prose stretches to about 0.6 em, and the narrowest column gap
// seen is 1.1 em (ESP32-WROOM-32, "Typ" to "Max").

import type { Box, Cell, Line, PageItems, TextItem } from "./types";

export const ROW_BUILDER_VERSION = "rows-1";
export const CELL_GAP_EM = 0.8;
const SMALLER = 0.85;
const MARKER = /^\(?\d{1,2}\)?([,\s]+\(?\d{1,2}\)?)*$/;

interface Group {
  y: number;
  fs: number;
  items: TextItem[];
  smalls: TextItem[];
}

function markerRefs(text: string): string[] {
  return text.split(/[,\s]+/).map((t) => t.replace(/[()]/g, "")).filter((t) => t !== "");
}

export function buildLines(page: PageItems): Line[] {
  const items = page.items.filter((i) => i.str.trim() !== "" && i.fs > 0);
  const body = items.filter((i) => i.fs > 0);
  // Full-size items first, top to bottom, so small items can attach to an existing line.
  const sorted = [...body].sort((a, b) => b.fs - a.fs || b.y - a.y || a.x - b.x);
  const groups: Group[] = [];
  for (const it of sorted) {
    const host = groups.find(
      (g) =>
        Math.abs(g.y - it.y) <= 0.5 * Math.min(g.fs, it.fs) ||
        (it.fs < SMALLER * g.fs && Math.abs(g.y - it.y) <= 0.5 * g.fs),
    );
    if (!host) groups.push({ y: it.y, fs: it.fs, items: [it], smalls: [] });
    else if (it.fs < SMALLER * host.fs) host.smalls.push(it);
    else host.items.push(it);
  }
  groups.sort((a, b) => b.y - a.y);

  const lines: Line[] = [];
  for (const g of groups) {
    const footnoteRefs: string[] = [];
    const inline: TextItem[] = [...g.items];
    for (const s of g.smalls) {
      const superscript = s.y > g.y + 0.15 * g.fs;
      if (superscript && MARKER.test(s.str.trim())) footnoteRefs.push(...markerRefs(s.str.trim()));
      else inline.push(s); // a subscript such as the CC of VCC reads as part of the word
    }
    inline.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    let current: TextItem[] = [];
    const flush = () => {
      if (current.length === 0) return;
      let text = "";
      let prevEnd: number | null = null;
      for (const it of current) {
        if (prevEnd !== null && it.x - prevEnd > 0.15 * Math.max(it.fs, 1)) text += " ";
        text += it.str;
        prevEnd = it.x + it.w;
      }
      const x0 = Math.min(...current.map((i) => i.x));
      const x1 = Math.max(...current.map((i) => i.x + i.w));
      cells.push({ text: text.trim(), x0: x0 / page.width, x1: x1 / page.width, index: cells.length });
      current = [];
    };
    let prevEnd: number | null = null;
    for (const it of inline) {
      if (prevEnd !== null && (it.x - prevEnd) / g.fs > CELL_GAP_EM) flush();
      current.push(it);
      prevEnd = Math.max(prevEnd ?? -Infinity, it.x + it.w);
    }
    flush();
    const text = cells.map((c) => c.text).join(" | ");
    // A line holding only footnote markers is a reference, not text.
    if (MARKER.test(text.replace(/\s*\|\s*/g, ","))) {
      const previous = lines[lines.length - 1];
      if (previous) previous.footnoteRefs.push(...markerRefs(text.replace(/\s*\|\s*/g, ",")));
      continue;
    }
    const all = [...g.items, ...g.smalls];
    const x0 = Math.min(...all.map((i) => i.x));
    const x1 = Math.max(...all.map((i) => i.x + i.w));
    const top = Math.max(...all.map((i) => i.y + 0.8 * i.fs));
    const bottom = Math.min(...all.map((i) => i.y - 0.2 * i.fs));
    const bbox: Box = {
      x: x0 / page.width,
      y: (page.height - top) / page.height,
      width: (x1 - x0) / page.width,
      height: (top - bottom) / page.height,
    };
    lines.push({ text, cells, bbox, fontSize: g.fs, footnoteRefs });
  }
  return lines;
}

const BAD = /[�-\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** A text layer is usable with at least 200 characters, fewer than 2 percent of them unreadable. */
export function usableTextLayer(page: PageItems): boolean {
  const text = page.items.map((i) => i.str).join("");
  const chars = text.replace(/\s/g, "");
  if (chars.length < 200) return false;
  const bad = (chars.match(BAD) ?? []).length;
  return bad / chars.length < 0.02;
}

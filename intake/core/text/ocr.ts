// OCR lines (ground-intake-extraction D2): a digitised page's regions become lines. HTML
// tables become pipe rows whose cells keep their index (OCR keeps empty cells); every line
// takes the box of the region it came from. Pure.

import type { DigitisedPage } from "../digitised";
import type { Cell, Line } from "./types";

export const OCR_ROWS_VERSION = "ocr-rows-1";

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

export function ocrLines(page: DigitisedPage): Line[] {
  const lines: Line[] = [];
  for (const region of page.regions) {
    const bbox = { x: region.bbox.x, y: region.bbox.y, width: region.bbox.width, height: region.bbox.height };
    if (/<table/i.test(region.text)) {
      for (const row of region.text.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
        const cells: Cell[] = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map((c, index) => ({
          text: plain(c),
          index,
        }));
        if (cells.every((c) => c.text === "")) continue;
        lines.push({ text: cells.map((c) => c.text).join(" | "), cells, bbox, fontSize: 0, footnoteRefs: [] });
      }
      continue;
    }
    for (const raw of region.text.split("\n")) {
      const text = plain(raw.replace(/^#+\s*/, ""));
      if (text === "") continue;
      lines.push({ text, cells: [{ text, index: 0 }], bbox, fontSize: 0, footnoteRefs: [] });
    }
  }
  return lines;
}

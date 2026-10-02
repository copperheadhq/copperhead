// The PDF text-layer reader (ground-intake-extraction D2): pdf.js on the server, legacy build,
// no worker. Returns raw items; core/text builds lines from them.

import type { PageItems, TextItem } from "../core/text/types";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfJs> | undefined;

function load(): Promise<PdfJs> {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

/** The pdf.js version, which keys the text cache through the reader version. */
export async function pdfjsVersion(): Promise<string> {
  return (await load()).version;
}

export interface PdfText {
  numPages: number;
  /** The pdf.js version, part of the reader version recorded on every page. */
  version: string;
  pages: PageItems[];
}

/** Read the text items of the given 1-based pages (all pages when omitted). Rotated text is skipped. */
export async function readPdfItems(bytes: Uint8Array, pages?: number[]): Promise<PdfText> {
  const lib = await load();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const wanted = pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const out: PageItems[] = [];
    for (const n of wanted) {
      if (n < 1 || n > doc.numPages) throw new RangeError(`page ${n} is outside the document (1 to ${doc.numPages})`);
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const raw of content.items) {
        if (!("str" in raw)) continue;
        const [a, b, c, d, e, f] = raw.transform as number[];
        if (Math.abs(b ?? 0) > 0.01 * Math.abs(a ?? 1) || Math.abs(c ?? 0) > 0.01 * Math.abs(d ?? 1)) continue;
        items.push({ str: raw.str, x: e ?? 0, y: f ?? 0, w: raw.width, fs: Math.hypot(c ?? 0, d ?? 0) });
      }
      out.push({ page: n, width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
    return { numPages: doc.numPages, version: lib.version, pages: out };
  } finally {
    await task.destroy();
  }
}

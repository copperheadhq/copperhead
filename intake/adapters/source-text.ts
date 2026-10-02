// Source text (ground-intake-extraction D2): the text layer first, OCR only for pages without a
// usable one, every page marked with the text it used and the reader that produced it.

import type { DigitisedPage } from "../core/digitised";
import { buildLines, ROW_BUILDER_VERSION, usableTextLayer } from "../core/text/lines";
import { ocrLines, OCR_ROWS_VERSION } from "../core/text/ocr";
import type { SourcePage } from "../core/text/types";
import { readPdfItems } from "./pdf-text";

export interface SourceTextOptions {
  /** 1-based pages to read; all pages when omitted. */
  pages?: number[];
  /** Send every selected page to OCR, even where the text layer is usable. */
  forceOcr?: boolean;
  /** Digitise the document; called at most once, and only when a page needs OCR. */
  digitise?: () => Promise<DigitisedPage[]>;
  /** The OCR provider's id, recorded in the reader of OCR pages. */
  ocrModel?: string;
}

export interface SourceText {
  numPages: number;
  pages: SourcePage[];
  /** True when any page was read by OCR. */
  usedOcr: boolean;
}

export function textReaderVersion(pdfjsVersion: string): string {
  return `pdfjs-${pdfjsVersion}+${ROW_BUILDER_VERSION}`;
}

export function ocrReaderVersion(ocrModel: string): string {
  return `${ocrModel}+${OCR_ROWS_VERSION}`;
}

export async function readSourceText(bytes: Uint8Array, opts: SourceTextOptions = {}): Promise<SourceText> {
  const pdf = await readPdfItems(bytes, opts.pages);
  const textReader = textReaderVersion(pdf.version);
  let digitised: DigitisedPage[] | undefined;
  const pages: SourcePage[] = [];
  for (const items of pdf.pages) {
    if (!opts.forceOcr && usableTextLayer(items)) {
      pages.push({ page: items.page, textSource: "pdf-text", reader: textReader, lines: buildLines(items) });
      continue;
    }
    if (!opts.digitise) {
      throw new Error(
        `page ${items.page} has no usable text layer${opts.forceOcr ? " (OCR forced)" : ""} and no OCR provider was given`,
      );
    }
    digitised ??= await opts.digitise();
    const ocrPage = digitised.find((p) => p.page === items.page);
    if (!ocrPage) throw new Error(`OCR returned no page ${items.page}`);
    pages.push({
      page: items.page,
      textSource: "ocr",
      reader: ocrReaderVersion(opts.ocrModel ?? "ocr"),
      lines: ocrLines(ocrPage),
    });
  }
  return { numPages: pdf.numPages, pages, usedOcr: pages.some((p) => p.textSource === "ocr") };
}

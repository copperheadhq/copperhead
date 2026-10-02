// Sarvam Digitise provider: the async job lifecycle against the confirmed
// sarvamai JS SDK surface (createJob -> uploadFile -> start ->
// waitUntilComplete -> downloadOutput), wrapped in the SPEC's resilience
// budget (90 s poll timeout, backoff on 429/503) and a page-budget guard.
//
// The output ZIP's page-level JSON schema is tolerant-mapped into
// DigitisedPage[]; the raw entries are persisted beside the cache so the
// real schema can be inspected after the first live call.

import { SarvamAIClient } from "sarvamai";
import { unzipSync, strFromU8 } from "fflate";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoundingBox, DigitisedPage, DigitisedRegion } from "../core/digitised";
import {
  DigitisationProvider,
  DigitiseFailedError,
  DigitiseTimeoutError,
  DocumentInput,
} from "../ports/digitisation";
import { sha256 } from "./cache";
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS, TimeoutError, withBackoff, withTimeout } from "./resilience";

/** The demo feeds at most this many pages; Sarvam hard-caps at 10. */
export const MAX_PAGES = 2;
/** The Digitise options that, with the provider id, key the OCR cache. */
export const SARVAM_LANGUAGE = "en-IN";
export const SARVAM_OUTPUT_FORMAT = "md";
export const SARVAM_PAGE_LIMIT = 10;

/** Cheap page-count estimate: counts PDF page objects. Undercounts never block. */
export function estimatePdfPageCount(bytes: Buffer): number {
  const text = bytes.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Normalize the many plausible bbox encodings into our 0..1 BoundingBox. */
function mapBbox(raw: unknown, page: number, pageW?: number, pageH?: number): BoundingBox | undefined {
  let x: number | undefined, y: number | undefined, w: number | undefined, h: number | undefined;
  if (Array.isArray(raw) && raw.length === 4) {
    const [x0, y0, x1, y1] = raw.map(asNumber);
    if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return undefined;
    x = x0; y = y0; w = x1 - x0; h = y1 - y0;
  } else if (isRecord(raw)) {
    // Confirmed live schema: coordinates {x1, y1, x2, y2} as top-left and
    // bottom-right pixel corners.
    const cx1 = asNumber(raw.x1);
    const cy1 = asNumber(raw.y1);
    const cx2 = asNumber(raw.x2);
    const cy2 = asNumber(raw.y2);
    if (cx1 !== undefined && cy1 !== undefined && cx2 !== undefined && cy2 !== undefined) {
      x = cx1; y = cy1; w = cx2 - cx1; h = cy2 - cy1;
    } else {
      const rx = asNumber(raw.x) ?? asNumber(raw.x0) ?? asNumber(raw.left);
      const ry = asNumber(raw.y) ?? asNumber(raw.y0) ?? asNumber(raw.top);
      const rw = asNumber(raw.width) ?? asNumber(raw.w);
      const rh = asNumber(raw.height) ?? asNumber(raw.h);
      const rRight = asNumber(raw.right);
      const rBottom = asNumber(raw.bottom);
      if (rx === undefined || ry === undefined) return undefined;
      x = rx; y = ry;
      w = rw ?? (rRight !== undefined ? rRight - rx : undefined);
      h = rh ?? (rBottom !== undefined ? rBottom - ry : undefined);
    }
  }
  if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) {
    return undefined;
  }
  // Scale absolute pixel coordinates down to 0..1 when page dims are known
  // or the values are clearly not normalized.
  if (x > 1 || y > 1 || w > 1 || h > 1) {
    const scaleW = pageW && pageW > 1 ? pageW : undefined;
    const scaleH = pageH && pageH > 1 ? pageH : undefined;
    if (!scaleW || !scaleH) return undefined;
    x /= scaleW; w /= scaleW;
    y /= scaleH; h /= scaleH;
  }
  return { page, x, y, width: w, height: h };
}

function textOf(entry: Record<string, unknown>): string {
  for (const key of ["text", "content", "markdown", "value"]) {
    const v = entry[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return "";
}

/** Map one parsed page-level JSON object into a DigitisedPage. */
function mapPage(raw: Record<string, unknown>, fallbackPage: number): DigitisedPage {
  const page =
    asNumber(raw.page_num) ??
    asNumber(raw.page) ??
    asNumber(raw.page_number) ??
    asNumber(raw.pageNumber) ??
    fallbackPage;
  const pageW = asNumber(raw.image_width) ?? asNumber(raw.width) ?? asNumber(raw.page_width);
  const pageH = asNumber(raw.image_height) ?? asNumber(raw.height) ?? asNumber(raw.page_height);

  const regionSource = ["blocks", "regions", "elements", "items", "paragraphs", "cells", "lines"]
    .map((k) => raw[k])
    .find((v): v is unknown[] => Array.isArray(v));

  const regions: DigitisedRegion[] = [];
  for (const entry of regionSource ?? []) {
    if (!isRecord(entry)) continue;
    const text = textOf(entry);
    if (!text) continue;
    const bboxRaw =
      entry.coordinates ?? entry.bbox ?? entry.bounding_box ?? entry.boundingBox ?? entry.bounds;
    const bbox = mapBbox(bboxRaw, page, pageW, pageH);
    if (bbox) regions.push({ text, bbox });
  }

  const ownText = textOf(raw);
  const text = ownText || regions.map((r) => r.text).join("\n");
  return { page, text, regions };
}

/** Map the unzipped output entries into DigitisedPage[]. Exported for tests. */
export function mapSarvamOutput(entries: Record<string, Uint8Array>): DigitisedPage[] {
  const pages: DigitisedPage[] = [];
  const jsonNames = Object.keys(entries)
    .filter((n) => n.toLowerCase().endsWith(".json"))
    .sort();
  for (const name of jsonNames) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(strFromU8(entries[name]!));
    } catch {
      continue;
    }
    const indexFromName = Number((name.match(/(\d+)\.json$/) ?? [])[1]);
    const fallback = Number.isFinite(indexFromName) ? indexFromName : pages.length + 1;
    if (Array.isArray(parsed)) {
      parsed.filter(isRecord).forEach((p, i) => pages.push(mapPage(p, i + 1)));
    } else if (isRecord(parsed) && Array.isArray(parsed.pages)) {
      (parsed.pages as unknown[]).filter(isRecord).forEach((p, i) => pages.push(mapPage(p, i + 1)));
    } else if (isRecord(parsed)) {
      pages.push(mapPage(parsed, fallback));
    }
  }
  pages.sort((a, b) => a.page - b.page);
  return pages;
}

export class SarvamProvider implements DigitisationProvider {
  readonly modelId = "sarvam-vision";
  private readonly client: SarvamAIClient;
  private readonly workDir: string;
  private readonly onProgress: (message: string) => void;

  constructor(options: { apiKey?: string; workDir: string; onProgress?: (message: string) => void }) {
    const apiKey = options.apiKey ?? process.env.SARVAM_API_KEY;
    if (!apiKey) throw new DigitiseFailedError("SARVAM_API_KEY is not set");
    this.client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    this.workDir = options.workDir;
    this.onProgress = options.onProgress ?? (() => {});
  }

  async digitise(doc: DocumentInput): Promise<DigitisedPage[]> {
    // The estimate is a heuristic (object-count based, can over-count), so
    // it hard-blocks only at Sarvam's own limit and warns above the budget.
    const estimated = estimatePdfPageCount(doc.bytes);
    if (estimated > SARVAM_PAGE_LIMIT) {
      throw new DigitiseFailedError(
        `document appears to have ~${estimated} pages, over Sarvam's ${SARVAM_PAGE_LIMIT}-page limit; trim to the ${MAX_PAGES} relevant pages before ingesting`,
      );
    }
    if (estimated > MAX_PAGES) {
      console.warn(
        `[intake] ${doc.fileName}: estimated ~${estimated} pages; the demo budget is ${MAX_PAGES} relevant pages`,
      );
    }

    this.onProgress("creating Sarvam digitise job");
    const job = await withBackoff(() =>
      // Live API accepts only "html" or "md" (the SDK type also lists
      // "json", but the endpoint 400s on it); the page-level structured
      // JSON is always included in the output ZIP alongside the primary
      // format.
      this.client.documentIntelligence.createJob({
        language: SARVAM_LANGUAGE,
        outputFormat: SARVAM_OUTPUT_FORMAT,
        pollingIntervalMs: POLL_INTERVAL_MS,
      }),
    );

    this.onProgress(`uploading ${doc.fileName} to Sarvam`);
    const file = new File([new Uint8Array(doc.bytes)], doc.fileName, { type: "application/pdf" });
    await withBackoff(() => job.uploadFile(file));
    await withBackoff(() => job.start());

    this.onProgress("Sarvam Vision is reading the pages (polls every 2 s)");
    let status;
    try {
      status = await withTimeout(job.waitUntilComplete(), POLL_TIMEOUT_MS, "Sarvam digitise job");
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new DigitiseTimeoutError(err.message);
      }
      throw err;
    }
    const state = (status as { job_state?: string }).job_state;
    if (state === "Failed") {
      throw new DigitiseFailedError(`Sarvam job ${job.jobId} failed`);
    }

    this.onProgress("downloading digitised output (ZIP with page JSON + bounding boxes)");
    mkdirSync(this.workDir, { recursive: true });
    const zipPath = join(this.workDir, `${sha256(doc.bytes).slice(0, 16)}.output.zip`);
    await job.downloadOutput(zipPath);

    const { readFileSync } = await import("node:fs");
    const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));

    // Persist the raw page JSON beside the cache for schema inspection.
    const rawDir = join(this.workDir, "raw");
    mkdirSync(rawDir, { recursive: true });
    for (const [name, bytes] of Object.entries(entries)) {
      writeFileSync(join(rawDir, name.replace(/[/\\]/g, "_")), bytes);
    }

    const pages = mapSarvamOutput(entries);
    if (pages.length === 0) {
      throw new DigitiseFailedError(
        "Sarvam output contained no mappable page JSON; inspect the raw entries in the cache directory",
      );
    }
    return pages;
  }
}

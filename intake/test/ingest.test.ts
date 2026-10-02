// Ingestion and the cache (ground-intake-extraction D2, D3, D9; datasheet-ingestion spec).

import { describe, expect, it } from "vitest";
import { ingest } from "../adapters/ingest";
import type { IntakeExtraction } from "../core/extraction";
import { demoPdf } from "./support/demo-part";
import { CannedExtractor, idOf, tempDeps } from "./support/fixtures";

const bytes = Buffer.from(demoPdf());
const doc = { fileName: "demo-io-expander.pdf", bytes };

function leakage(units: { evidenceId: string; text: string }[]): IntakeExtraction[] {
  return [{ field: "pin_input_leakage_uA", evidenceId: idOf(units as never, "Input leakage current"), value: "0.033", unit: "mA", qualifier: "MAX", confidence: 0.93 }];
}

describe("ingestion", () => {
  it("reads the text layer, never OCR, and validates the extraction", async () => {
    const extractor = new CannedExtractor("model-a", leakage);
    const result = await ingest(doc, tempDeps(extractor));
    expect(result.pages.map((p) => p.textSource)).toEqual(["pdf-text", "pdf-text"]);
    expect(result.ocrModel).toBeUndefined();
    expect(result.records.map((r) => r.outcome)).toEqual(["ADMITTED"]);
    expect(result.extractorModel).toBe("model-a");
    expect(result.promptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("serves a repeat ingest from the cache with no extractor call", async () => {
    const extractor = new CannedExtractor("model-a", leakage);
    const deps = tempDeps(extractor);
    await ingest(doc, deps);
    await ingest(doc, deps);
    expect(extractor.calls).toBe(1);
  });

  it("does not serve a cached extraction to a different model", async () => {
    const a = new CannedExtractor("model-a", leakage);
    const deps = tempDeps(a);
    await ingest(doc, deps);
    const b = new CannedExtractor("model-b", leakage);
    const result = await ingest(doc, { ...deps, extractor: b, extractorModel: "model-b" });
    expect(b.calls).toBe(1);
    expect(result.extractorModel).toBe("model-b");
  });

  it("does not serve a cached extraction for other pages", async () => {
    const extractor = new CannedExtractor("model-a", () => []);
    const deps = tempDeps(extractor);
    await ingest(doc, deps, { pages: [1] });
    await ingest(doc, deps, { pages: [2] });
    await ingest(doc, deps, { pages: [1] });
    expect(extractor.calls).toBe(2);
  });

  it("records an explicit new pass beside the old one and reports what differs", async () => {
    let answer: "first" | "second" = "first";
    const extractor = new CannedExtractor("model-a", (units) =>
      answer === "first" ? leakage(units) : [{ ...leakage(units)[0]!, value: "0.033", qualifier: "TYP" }],
    );
    const deps = tempDeps(extractor);
    await ingest(doc, deps);
    answer = "second";
    const again = await ingest(doc, deps, { newPass: true });
    expect(again.passes).toBe(2);
    expect(again.changedSincePreviousPass?.added.map((e) => e.qualifier)).toEqual(["TYP"]);
    expect(again.changedSincePreviousPass?.removed.map((e) => e.qualifier)).toEqual(["MAX"]);
    const plain = await ingest(doc, deps);
    expect(plain.passes).toBe(2);
    expect(extractor.calls).toBe(2);
  });

  it("cached mode never calls a model: a miss is an error, a hit names the model that ran", async () => {
    const live = tempDeps(new CannedExtractor("model-a", leakage));
    const { extractor: _e, ...cachedOnly } = live;
    await expect(ingest(doc, cachedOnly)).rejects.toThrow(/no cached extraction/);
    await ingest(doc, live);
    const cached = await ingest(doc, cachedOnly);
    expect(cached.extractorModel).toBe("model-a");
    expect(cached.records).toHaveLength(1);
  });
});

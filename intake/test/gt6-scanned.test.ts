// GT-6: the hard scanned-era document, the onsemi 2N3055 (ground-intake-extraction D11). Its
// Sarvam output was captured live on 2026-07-26 and is committed; its extraction is the same
// day's live capture, translated into a pointer at the OCR line holding its snippet
// (fixtures/gt6/). The PDF has a text layer, so the test forces OCR to keep exercising that path.
// Acceptance: every page is read by OCR with boxes, the uncertain absolute-maximum read is held
// for review, and it never decides a verdict.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonCache } from "../adapters/cache";
import { FixtureDigitisationProvider } from "../adapters/fixtures";
import { readSourceText } from "../adapters/source-text";
import { evaluateChange } from "../core/evaluate";
import type { IntakeExtraction } from "../core/extraction";
import { DEFAULT_FIELD_SPECS } from "../core/fields";
import { partRef, type ChangeDescriptor } from "../core/model";
import { parseRegistry, snapshotFor, storeReadings } from "../core/registry";
import { mintUnits } from "../core/text/units";
import { validateExtractions } from "../core/validate";
import { docRef } from "./support/fixtures";

const FIXTURES = join(process.cwd(), "fixtures");
const bytes = readFileSync(join(FIXTURES, "datasheets", "2n3055-scanned.pdf"));
const document = docRef(bytes, "2n3055-scanned.pdf");
const gt6 = JSON.parse(readFileSync(join(FIXTURES, "gt6", "2n3055.extractions.json"), "utf8")) as { model: string; extractions: IntakeExtraction[] };
const ocr = new FixtureDigitisationProvider(new JsonCache(join(FIXTURES, "cache")));

async function read() {
  const text = await readSourceText(bytes, { forceOcr: true, digitise: () => ocr.digitise({ fileName: "2n3055-scanned.pdf", bytes }), ocrModel: ocr.modelId });
  const units = mintUnits(document, text.pages);
  const records = validateExtractions(gt6.extractions, units, {
    specs: DEFAULT_FIELD_SPECS,
    knownDocuments: new Map([[document.sha256, document]]),
    contributor: gt6.model,
    provider: { id: gt6.model },
    now: () => "2026-07-26T00:00:00.000Z",
  });
  return { text, units, records };
}

const driveFromRail: ChangeDescriptor = { kind: "connect_rail", label: "drive the base pin from the 5V rail", contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }] };

describe("GT-6: hard scanned document extracts with the uncertain read held", () => {
  it("reads every page by OCR, with lines and boxes", async () => {
    const { text, units } = await read();
    expect(text.pages.length).toBe(5);
    for (const page of text.pages) {
      expect(page.textSource).toBe("ocr");
      expect(page.reader).toBe("sarvam-vision+ocr-rows-1");
      expect(page.lines.length).toBeGreaterThan(0);
    }
    for (const unit of units) expect(unit.bbox).toBeDefined();
  });

  it("holds the uncertain absolute-maximum read for review, with its provenance", async () => {
    const { records } = await read();
    const absMax = records.find((r) => r.extraction.field === "abs_max_vin_V")!;
    expect(absMax.outcome).toBe("REVIEW_REQUIRED");
    expect(absMax.reasonCodes).toEqual(["LOW_CONFIDENCE"]);
    expect(absMax.unit?.text).toBe("Emitter–Base Voltage | VEB | 7 | Vdc");
    expect(absMax.unit?.page).toBe(1);
    expect(absMax.unit?.textSource).toBe("ocr");
    expect(absMax.reading?.measurement).toMatchObject({ value_decimal: "7", unit: "V" });
  });

  it("never lets the held read decide: the rail change is HOLD", async () => {
    const { records } = await read();
    const part = partRef("onsemi", "2N3055");
    const seed = parseRegistry(readFileSync(join(FIXTURES, "registry.seed.json"), "utf8"));
    const admitted = records.filter((r) => r.outcome === "ADMITTED").map((r) => ({ key: r.extraction.field, reading: r.reading as never }));
    const registry = storeReadings(seed, part, document, admitted, DEFAULT_FIELD_SPECS);
    const { verdict } = evaluateChange({
      change: driveFromRail,
      partId: part.id,
      snapshot: snapshotFor(registry, part.id),
      constraints: registry.constraints,
      context: { decisionRunId: "gt6", timestampISO: "2026-07-26T00:00:00.000Z", providers: [], ruleVersion: "gt6" },
    });
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toEqual(["EVIDENCE_MISSING"]);
    expect(verdict.reason).toContain("abs_max_vin_V");
  });
});

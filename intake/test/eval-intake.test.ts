// The intake's benchmark path (ground-intake-extraction D12; extraction-evaluation spec).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IntakeExtraction } from "../core/extraction";
import { DEFAULT_FIELD_SPECS } from "../core/fields";
import type { Corpus, CorpusDocument } from "../eval/corpus";
import { ingest } from "../adapters/ingest";
import { ablate, soleStops, stoppedScores } from "../eval/ablation";
import { intakeIngester } from "../eval/intake";
import { runEvaluationWith } from "../eval/run";
import type { IntakeUnit } from "../core/text/types";
import { demoPdf } from "./support/demo-part";
import { CannedExtractor, idOf, tempDeps } from "./support/fixtures";

const bytes = Buffer.from(demoPdf());
const sha = createHash("sha256").update(bytes).digest("hex");

const doc: CorpusDocument = {
  documentId: "demo-io-expander",
  vendor: "Demo Semiconductor",
  mpn: "DEMO-IO-EXPANDER",
  revision: "A",
  sourceType: "born-digital",
  content: { kind: "reference", sha256: sha },
  caseTags: ["clean"],
  fields: DEFAULT_FIELD_SPECS.map((s) => ({
    key: s.key,
    description: s.description,
    expectDimension: s.dimension,
    parameter: { key: s.key, dimension: s.dimension, requiredConditions: s.requiredConditions },
  })),
  labels: {
    adjudicated: {
      labeler: "test",
      labeledAtISO: "2026-10-02T00:00:00.000Z",
      fields: {
        pin_input_leakage_uA: { value: "0.033", unit: "mA", qualifier: "MAX", citation: { page: 2, textContains: "Input leakage current" } },
        abs_max_vin_V: { value: "3.6", unit: "V", qualifier: "ABS_MAX", citation: { page: 1, textContains: "Input voltage VIN" } },
        supply_voltage_V: [
          { value: "1.65", unit: "V", qualifier: "MIN", citation: { page: 2, textContains: "Supply voltage" } },
          { value: "3.6", unit: "V", qualifier: "MAX", citation: { page: 2, textContains: "Supply voltage" } },
        ],
        quiescent_current_uA: { value: "1.5", unit: "uA", qualifier: "MAX", citation: { page: 2, textContains: "Quiescent current" } },
        recommended_pullup_ohm: "ABSENT",
      },
    },
  },
};

function corpusIn(dir: string): { corpus: Corpus; pdfDir: string } {
  const pdfDir = join(dir, "pdfs");
  mkdirSync(pdfDir, { recursive: true });
  writeFileSync(join(pdfDir, `${sha}.pdf`), bytes);
  return { corpus: { datasetVersion: "test-1", releaseSets: { all: [doc.documentId] }, decisionFixtures: [], documents: [doc] }, pdfDir };
}

const answer = (units: IntakeUnit[]): IntakeExtraction[] => [
  { field: "pin_input_leakage_uA", evidenceId: idOf(units, "Input leakage current"), value: "0.033", unit: "mA", qualifier: "MAX", confidence: 0.95 },
  { field: "abs_max_vin_V", evidenceId: idOf(units, "Input voltage VIN"), value: "3.6", unit: "V", qualifier: "ABS_MAX", confidence: 0.95 },
  // Wrong: the supply minimum misread, with high confidence.
  { field: "supply_voltage_V", evidenceId: idOf(units, "Supply voltage"), value: "3.6", unit: "V", qualifier: "MIN", confidence: 0.92 },
  { field: "quiescent_current_uA", evidenceId: idOf(units, "Quiescent current"), value: "1.5", unit: "uA", qualifier: "MAX", footnoteQualified: true, confidence: 0.9 },
];

describe("the intake's evaluation", () => {
  it("scores admitted readings and counts reviews and validator outcomes", async () => {
    const deps = tempDeps(new CannedExtractor("model-a", answer));
    const { corpus, pdfDir } = corpusIn(deps.dir);
    const report = await runEvaluationWith(corpus, intakeIngester({ pdfDir, deps, now: () => "2026-10-02T00:00:00.000Z" }), "model-a", {
      releaseSet: "all",
      now: () => "2026-10-02T00:00:00.000Z",
    });
    // The misread MIN sits under the MAX column, so the qualifier check rejects it before scoring.
    expect(report.metrics.admittedReadings).toBe(2);
    expect(report.metrics.correctReadings).toBe(2);
    expect(report.metrics.fieldPrecision).toBe(1);
    expect(report.metrics.citationAccuracy).toBe(1);
    expect(report.documents[0]!.routedToReview).toBe(1);
    expect(report.documents[0]!.rejected).toBe(1);
    expect(report.documents[0]!.reasonCounts).toMatchObject({ "qualifier-column:REJECTED": 1, "footnote-hold:REVIEW_REQUIRED": 1 });
    // Five expected readings, two produced: recall is reported, not gated.
    expect(report.metrics.fieldRecall).toBeCloseTo(2 / 5);
    expect(report.golden).toBe(false);
    expect(report.calibrationRecord).toBeUndefined();
  });

  it("a wrong reading that passes every validator counts against precision", async () => {
    const wrong = (units: IntakeUnit[]): IntakeExtraction[] => [
      { field: "abs_max_vin_V", evidenceId: idOf(units, "Input voltage VIN"), value: "3.6", unit: "V", qualifier: "ABS_MAX", confidence: 0.95 },
      // Admissible but wrong: the leakage line's 0.033 mA is in the cited line, under the MAX
      // column, a current; it is not the quiescent current. Only a label can catch it.
      { field: "quiescent_current_uA", evidenceId: idOf(units, "Input leakage current"), value: "0.033", unit: "mA", qualifier: "MAX", confidence: 0.95 },
    ];
    const deps = tempDeps(new CannedExtractor("model-a", wrong));
    const { corpus, pdfDir } = corpusIn(deps.dir);
    const report = await runEvaluationWith(corpus, intakeIngester({ pdfDir, deps, now: () => "x" }), "model-a", { releaseSet: "all", now: () => "x" });
    expect(report.metrics.admittedReadings).toBe(2);
    expect(report.metrics.wrongReadings).toBe(1);
    expect(report.metrics.fieldPrecision).toBe(0.5);
    expect(report.metrics.wrongWhileConfident).toBe(0.5);
    expect(report.gates.find((g) => g.gate === "field-precision")?.passed).toBe(false);
  });

  it("offline, a document with no cached extraction is reported as not evaluated", async () => {
    const live = tempDeps(new CannedExtractor("model-a", answer));
    const { extractor: _e, ...cachedOnly } = live;
    const { corpus, pdfDir } = corpusIn(live.dir);
    const report = await runEvaluationWith(corpus, intakeIngester({ pdfDir, deps: cachedOnly, now: () => "x" }), "cached", { releaseSet: "all", now: () => "x" });
    expect(report.documents).toEqual([]);
    expect(report.notEvaluated?.[0]?.reason).toMatch(/no cached extraction/);
  });

  it("ablation with every validator reproduces the benchmark; without one, it shows what that one stopped", async () => {
    const deps = tempDeps(new CannedExtractor("model-a", answer));
    const result = await ingest({ fileName: "demo.pdf", bytes }, deps, { specs: DEFAULT_FIELD_SPECS, revision: "A" });
    const docs = [{ document: doc, records: result.records }];
    expect(ablate(docs, new Set())).toMatchObject({ admitted: 2, correct: 2, wrong: 0, review: 1, rejected: 1, precision: 1, recall: 2 / 5 });
    // Without the qualifier column check the misread MIN is admitted, and it is wrong.
    expect(ablate(docs, new Set(["qualifier-column"]))).toMatchObject({ admitted: 3, correct: 2, wrong: 1 });
    // Without the footnote hold the footnoted quiescent current is admitted, and it is right.
    expect(ablate(docs, new Set(["footnote-hold"]))).toMatchObject({ admitted: 3, correct: 3, wrong: 0, recall: 3 / 5 });
    expect(soleStops(docs)).toEqual({
      "qualifier-column": { correct: 0, wrong: 1, unparseable: 0 },
      "footnote-hold": { correct: 1, wrong: 0, unparseable: 0 },
    });
    expect(stoppedScores(docs)).toEqual({ correct: 1, wrong: 1, unparseable: 0 });
  });

  it("refuses a PDF whose hash does not match the corpus", async () => {
    const deps = tempDeps(new CannedExtractor("model-a", answer));
    const { corpus, pdfDir } = corpusIn(deps.dir);
    writeFileSync(join(pdfDir, `${sha}.pdf`), Buffer.from("tampered"));
    const report = await runEvaluationWith(corpus, intakeIngester({ pdfDir, deps, now: () => "x" }), "model-a", { releaseSet: "all", now: () => "x" });
    expect(report.notEvaluated?.[0]?.reason).toMatch(/does not match/);
  });
});

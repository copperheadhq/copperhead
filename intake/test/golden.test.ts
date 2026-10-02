// Golden tests GT-1..GT-5 (ground-intake-extraction D11): the demo scenarios end to end and
// offline, on a synthetic text-layer datasheet with the exact SPEC values: 33 uA input leakage
// against a 25 uA sleep budget, a 3.6 V absolute maximum against a 5 V rail, and a
// footnote-qualified quiescent current.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ingest, type IngestDeps, type IngestResult } from "../adapters/ingest";
import { RegistryStore } from "../adapters/registry-store";
import { evaluateChange } from "../core/evaluate";
import type { IntakeExtraction } from "../core/extraction";
import { DEFAULT_FIELD_SPECS } from "../core/fields";
import { buildManifest, reproduces } from "../core/manifest";
import { partRef, type ChangeDescriptor, type Registry } from "../core/model";
import { snapshotFor } from "../core/registry";
import type { IntakeUnit } from "../core/text/types";
import { demoPdf } from "./support/demo-part";
import { CannedExtractor, idOf, tempDeps, writeSeed } from "./support/fixtures";

const PART = partRef("Demo Semiconductor", "DEMO-IO-EXPANDER");
const doc = { fileName: "demo-io-expander.pdf", bytes: Buffer.from(demoPdf()) };

// The seed with the golden tests' 5 V rail rule, so the 3.6 V absolute maximum decides GT-2.
const SEED = (() => {
  const seed = JSON.parse(readFileSync(join(process.cwd(), "fixtures", "registry.seed.json"), "utf8")) as Registry;
  seed.constraints[1]!.limit = { value_decimal: "5", unit: "V", si_value_decimal: "5" };
  return seed;
})();

function extractions(units: IntakeUnit[]): IntakeExtraction[] {
  return [
    { field: "pin_input_leakage_uA", evidenceId: idOf(units, "Input leakage current"), value: "0.033", unit: "mA", qualifier: "MAX", confidence: 0.93 },
    { field: "abs_max_vin_V", evidenceId: idOf(units, "Input voltage VIN"), value: "3.6", unit: "V", qualifier: "ABS_MAX", confidence: 0.91 },
    { field: "quiescent_current_uA", evidenceId: idOf(units, "Quiescent current"), value: "1.5", unit: "uA", qualifier: "MAX", footnoteQualified: true, confidence: 0.88 },
    { field: "supply_voltage_V", evidenceId: idOf(units, "Supply voltage"), value: "1.65", unit: "V", qualifier: "MIN", confidence: 0.9 },
    { field: "supply_voltage_V", evidenceId: idOf(units, "Supply voltage"), value: "3.6", unit: "V", qualifier: "MAX", confidence: 0.9 },
  ];
}

const pullUp: ChangeDescriptor = { kind: "add_component", label: "add 100k pull-up on a sleeping GPIO", contributions: [{ factKey: "pin_input_leakage_uA" }] };
const driveFrom5V: ChangeDescriptor = { kind: "connect_rail", label: "drive this pin from the 5V rail", contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }] };
const sleepCurrent: ChangeDescriptor = { kind: "add_component", label: "keep the part powered in sleep", contributions: [{ factKey: "quiescent_current_uA" }] };
const CONTEXT = { decisionRunId: "run-1", timestampISO: "2026-10-02T00:00:00.000Z", providers: [], ruleVersion: "golden" };

/** A deep copy with every object's keys in reverse order. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as object).reverse().map(([k, v]) => [k, reverseKeys(v)])) as T;
  }
  return value;
}

let extractor: CannedExtractor;
let deps: IngestDeps;
let store: RegistryStore;

beforeEach(() => {
  extractor = new CannedExtractor("claude-code", extractions);
  const d = tempDeps(extractor);
  deps = d;
  store = new RegistryStore(writeSeed(d.dir, SEED));
});

/** Ingest, store the admitted readings, evaluate: the evaluate route's path. */
function evaluateWith(result: IngestResult, change: ChangeDescriptor, save = true) {
  const candidate = store.withReadings(store.load(), PART, result.document, result.records, DEFAULT_FIELD_SPECS);
  const snapshot = snapshotFor(candidate, PART.id);
  const out = evaluateChange({ change, partId: PART.id, snapshot, constraints: candidate.constraints, context: CONTEXT });
  if (save && out.verdict.decision !== "HOLD") store.save(candidate);
  return { ...out, snapshot, constraints: candidate.constraints };
}

describe("GT-1: pull-up refused against the sleep budget", () => {
  it("refuses 33 uA > 25 uA citing the leakage line and the budget, with the internal pull-up fix", async () => {
    const result = await ingest(doc, deps);
    const { verdict, checks, snapshot, constraints } = evaluateWith(result, pullUp);
    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.reasonCodes).toEqual(["BUDGET_EXCEEDED"]);
    expect(verdict.computed?.result).toMatchObject({ value_decimal: "33", unit: "uA" });
    expect(verdict.computed?.limit).toMatchObject({ value_decimal: "25", unit: "uA" });
    expect(verdict.citedReadings[0]!.evidence.text).toBe("Input leakage current | 0.033 | mA");
    expect(verdict.citedReadings[0]!.evidence.bbox).toBeDefined();
    expect(verdict.citedConstraint?.id).toBe("sleep_current_budget");
    expect(verdict.proposedFix).toContain("internal pull-up");

    const manifest = buildManifest({
      timestampISO: CONTEXT.timestampISO,
      decisionRunId: CONTEXT.decisionRunId,
      partId: PART.id,
      descriptor: pullUp,
      constraints,
      snapshot,
      result: { verdict, checks },
      ruleVersion: CONTEXT.ruleVersion,
      document: result.document,
      pages: result.pages,
      extraction: { extractorModel: result.extractorModel, promptHash: result.promptHash, schemaVersion: "extractions-1" },
      validators: [],
    });
    expect(manifest.document?.sha256).toBe(result.document.sha256);
    expect(manifest.pages.map((p) => p.textSource)).toEqual(["pdf-text", "pdf-text"]);
    expect(manifest.extraction.extractorModel).toBe("claude-code");
    expect(manifest.factVersions).toHaveLength(1);
    expect(reproduces(manifest)).toBe(true);
    // Reproduction compares canonical JSON, so key order does not matter.
    expect(reproduces(reverseKeys(manifest))).toBe(true);
    expect(reproduces({ ...manifest, verdict: { ...manifest.verdict, decision: "APPROVE" } })).toBe(false);
  });
});

describe("GT-2: 5 V rail refused against the 3.6 V absolute maximum", () => {
  it("refuses 5 V > 3.6 V citing the absolute-maximum reading and the rule", async () => {
    const { verdict } = evaluateWith(await ingest(doc, deps), driveFrom5V);
    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.computed?.result.value_decimal).toBe("5");
    expect(verdict.computed?.limit.value_decimal).toBe("3.6");
    expect(verdict.citedReadings.map((r) => r.qualifier)).toEqual(["ABS_MAX"]);
    expect(verdict.citedConstraint?.id).toBe("rail_voltage_max");
  });
});

describe("GT-3: a footnote-qualified value is held, never decides", () => {
  it("returns HOLD naming the parameter to re-check", async () => {
    const result = await ingest(doc, deps);
    const quiescent = result.records.find((r) => r.extraction.field === "quiescent_current_uA")!;
    expect(quiescent.outcome).toBe("REVIEW_REQUIRED");
    expect(quiescent.reasonCodes).toContain("FOOTNOTE_QUALIFIED");
    const { verdict } = evaluateWith(result, sleepCurrent);
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toEqual(["EVIDENCE_MISSING"]);
    expect(verdict.reason).toContain("quiescent_current_uA");
  });
});

describe("GT-4: correcting the held value recomputes the verdict live", () => {
  it("a person's value makes the verdict decisive without re-extraction", async () => {
    const result = await ingest(doc, deps);
    expect(evaluateWith(result, sleepCurrent).verdict.decision).toBe("HOLD");
    const record = result.records.find((r) => r.extraction.field === "quiescent_current_uA")!;
    store.confirm(
      PART,
      result.document,
      "quiescent_current_uA",
      { evidence: { ...record.unit!, bbox: record.unit!.bbox! }, qualifier: "MAX", conditions: {} },
      { value: "1.5", unit: "uA" },
      { reviewer: "A. Reviewer", reason: "footnote checked", timestampISO: "2026-10-02T01:00:00.000Z" },
      DEFAULT_FIELD_SPECS,
    );
    const after = evaluateWith(result, sleepCurrent);
    expect(after.verdict.decision).toBe("APPROVE");
    expect(after.snapshot.facts.find((f) => f.key === "quiescent_current_uA")?.status).toBe("verified");
    expect(extractor.calls).toBe(1);
  });
});

describe("GT-5: a second change reuses stored readings with no new extraction", () => {
  it("evaluates from the registry without touching the extractor", async () => {
    const first = await ingest(doc, deps);
    expect(evaluateWith(first, pullUp).verdict.decision).toBe("REFUSE");
    expect(store.hasReadings(PART.id, ["pin_input_leakage_uA", "abs_max_vin_V"])).toBe(true);

    const registry = store.load();
    const { verdict } = evaluateChange({ change: driveFrom5V, partId: PART.id, snapshot: snapshotFor(registry, PART.id), constraints: registry.constraints, context: CONTEXT });
    expect(verdict.decision).toBe("REFUSE");
    const again = await ingest(doc, deps);
    expect(again.records.length).toBeGreaterThan(0);
    expect(extractor.calls).toBe(1);
  });
});

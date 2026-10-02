// The registry (ground-intake-extraction D6; registry-memory spec).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD_SPECS } from "../core/fields";
import { parseMeasurement } from "../core/knowledge/decimal";
import { partRef, type AdmittedReading, type Registry } from "../core/model";
import { confirmReading, correctReading, parseRegistry, RegistryError, snapshotFor, storeReadings } from "../core/registry";
import { unit } from "./support/fixtures";

const SEED = readFileSync(join(process.cwd(), "fixtures", "registry.seed.json"), "utf8");
const LM555 = partRef("Texas Instruments", "LM555");
const ESP32 = partRef("Espressif", "ESP32-WROOM-32");

function reading(sha: string, value: string, unitSymbol: string, qualifier: AdmittedReading["qualifier"] = "MAX"): AdmittedReading {
  const u = unit({ evidenceId: `ev-${sha.slice(0, 8)}-p1-l1`, text: `Supply Current | ${value} | ${unitSymbol}` });
  return {
    measurement: parseMeasurement(value, unitSymbol),
    qualifier,
    conditions: {},
    confidence: 0.9,
    evidence: { ...u, document: { ...u.document, sha256: sha }, bbox: u.bbox! },
    contributor: "claude-code",
    method: { kind: "extraction", providerId: "claude-code" },
    validators: [],
    addedAtISO: "2026-10-02T00:00:00.000Z",
  };
}

const docA = { documentId: "lm555.pdf", sha256: "a".repeat(64), authority: "MANUFACTURER" as const };
const docB = { documentId: "esp32.pdf", sha256: "b".repeat(64), authority: "MANUFACTURER" as const };

describe("parsing", () => {
  it("parses the seed: a worst-case sleep budget and a rail check with stressFrom", () => {
    const r = parseRegistry(SEED);
    expect(r.constraints.map((c) => [c.id, c.kind, c.limit.value_decimal, c.limit.unit, c.policy.bound])).toEqual([
      ["sleep_current_budget", "budget_sum", "25", "uA", "WORST_CASE"],
      ["rail_voltage_max", "max", "3.3", "V", "WORST_CASE"],
    ]);
    expect(r.constraints[1]!.stressFrom).toEqual({ key: "abs_max_vin_V" });
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["version 1", JSON.stringify({ part: "x", facts: [], constraints: [] }), /version must be 2/],
    ["a bare-number limit", SEED.replace('{ "value_decimal": "25", "unit": "uA" }', "25"), /must be a decimal/],
    ["an unknown unit", SEED.replace('"unit": "uA"', '"unit": "furlongs"'), /unknown unit/],
    ["an unknown kind", SEED.replace('"kind": "budget_sum"', '"kind": "ratio"'), /kind must be one of/],
    ["a missing policy", SEED.replace(/"policy": \{[^}]*\},\n\s*"stressFrom"/, '"stressFrom"'), /policy must be/],
    ["stressFrom on a budget", SEED.replace('"source": "board SPEC sleep budget",', '"source": "board SPEC sleep budget", "stressFrom": { "key": "x" },'), /stressFrom must be/],
  ])("fails closed on %s", (_label, text, message) => {
    expect(() => parseRegistry(text)).toThrow(RegistryError);
    expect(() => parseRegistry(text)).toThrow(message);
  });
});

describe("readings per part and document", () => {
  it("stores a reading under its part and never lets another part's reading decide", () => {
    let r: Registry = parseRegistry(SEED);
    r = storeReadings(r, LM555, docA, [{ key: "quiescent_current_uA", reading: reading(docA.sha256, "6", "mA") }], DEFAULT_FIELD_SPECS);
    expect(snapshotFor(r, LM555.id).facts.map((f) => [f.key, f.value.value_decimal])).toEqual([["quiescent_current_uA", "6"]]);
    expect(snapshotFor(r, ESP32.id).facts).toEqual([]);
    r = storeReadings(r, ESP32, docB, [{ key: "quiescent_current_uA", reading: reading(docB.sha256, "50", "nA") }], DEFAULT_FIELD_SPECS);
    expect(snapshotFor(r, ESP32.id).facts.map((f) => f.value.value_decimal)).toEqual(["50"]);
    expect(snapshotFor(r, LM555.id).facts.map((f) => f.value.value_decimal)).toEqual(["6"]);
  });

  it("refuses a reading from another document than the one named", () => {
    expect(() =>
      storeReadings(parseRegistry(SEED), LM555, docA, [{ key: "quiescent_current_uA", reading: reading(docB.sha256, "6", "mA") }], DEFAULT_FIELD_SPECS),
    ).toThrow(/another document/);
  });

  it("does not store the same reading twice", () => {
    const one = { key: "quiescent_current_uA", reading: reading(docA.sha256, "6", "mA") };
    let r = storeReadings(parseRegistry(SEED), LM555, docA, [one], DEFAULT_FIELD_SPECS);
    r = storeReadings(r, LM555, docA, [one], DEFAULT_FIELD_SPECS);
    expect(r.parts[LM555.id]!.parameters[0]!.readings).toHaveLength(1);
  });

  it("survives a round trip through JSON and the parser", () => {
    const r = storeReadings(parseRegistry(SEED), LM555, docA, [{ key: "quiescent_current_uA", reading: reading(docA.sha256, "6", "mA") }], DEFAULT_FIELD_SPECS);
    expect(parseRegistry(JSON.stringify(r))).toEqual(r);
  });
});

describe("corrections are human readings", () => {
  const audit = { reviewer: "A. Reviewer", reason: "misread", timestampISO: "2026-10-02T01:00:00.000Z" };

  it("keeps the extracted reading and makes the correction canonical and verified", () => {
    let r = storeReadings(parseRegistry(SEED), LM555, docA, [{ key: "quiescent_current_uA", reading: reading(docA.sha256, "3", "mA") }], DEFAULT_FIELD_SPECS);
    r = correctReading(r, LM555.id, "quiescent_current_uA", "MAX", { value: "6", unit: "mA" }, audit);
    const parameter = r.parts[LM555.id]!.parameters[0]!;
    expect(parameter.readings.map((x) => [x.measurement.value_decimal, x.method.kind])).toEqual([["3", "extraction"], ["6", "human"]]);
    expect(parameter.canonical).toEqual([expect.objectContaining({ status: "verified", value: expect.objectContaining({ value_decimal: "6" }) })]);
    expect(snapshotFor(r, LM555.id).facts.map((f) => [f.value.value_decimal, f.status])).toEqual([["6", "verified"]]);
  });

  it("records a person's value for a reviewed extraction, citing its unit", () => {
    const evidence = reading(docA.sha256, "1.5", "uA").evidence;
    const r = confirmReading(parseRegistry(SEED), LM555, docA, "quiescent_current_uA", { evidence, qualifier: "MAX", conditions: {} }, { value: "1.5", unit: "uA" }, audit, DEFAULT_FIELD_SPECS);
    const stored = r.parts[LM555.id]!.parameters[0]!.readings[0]!;
    expect(stored.method.kind).toBe("human");
    expect(stored.evidence.evidenceId).toBe(evidence.evidenceId);
    expect(snapshotFor(r, LM555.id).facts[0]!.status).toBe("verified");
  });

  it("refuses to correct what is not there", () => {
    expect(() => correctReading(parseRegistry(SEED), LM555.id, "quiescent_current_uA", "MAX", { value: "1", unit: "mA" }, audit)).toThrow(/no part/);
  });
});

describe("a correction names its line", () => {
  it("corrects the reading of the named line, not another reading with the same qualifier", () => {
    const audit = { reviewer: "A. Reviewer", reason: "misread", timestampISO: "2026-10-02T01:00:00.000Z" };
    const first = reading(docA.sha256, "15", "mA");
    const second = { ...reading(docA.sha256, "6", "mA"), evidence: { ...reading(docA.sha256, "6", "mA").evidence, evidenceId: "ev-aaaaaaaa-p1-l2" } };
    let r = storeReadings(parseRegistry(SEED), LM555, docA, [{ key: "quiescent_current_uA", reading: first }, { key: "quiescent_current_uA", reading: second }], DEFAULT_FIELD_SPECS);
    r = correctReading(r, LM555.id, "quiescent_current_uA", "MAX", { value: "6", unit: "mA" }, audit, first.evidence.evidenceId);
    const human = r.parts[LM555.id]!.parameters[0]!.readings.filter((x) => x.method.kind === "human");
    expect(human.map((x) => x.evidence.evidenceId)).toEqual([first.evidence.evidenceId]);
  });
});

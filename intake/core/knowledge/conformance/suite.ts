/**
 * Extraction-provider conformance suite (SPEC §3.4).
 *
 * Contract checks: RawExtraction[] shape; evidence ids echoed, never
 * invented; confidence ∈ [0,1]; no inference / conversion / arithmetic /
 * condition-filling; declared capabilities observed.
 * Behavioral checks: golden pages, prompt-injection page, forged-evidence page.
 */

import type {
  ExtractionProvider,
  RawExtraction,
} from "../provider/kinds";
import type { ConformanceFixture } from "./fixtures";
import { ALL_FIXTURES } from "./fixtures";

export interface ConformanceFailure {
  fixture: string;
  check: string;
  detail: string;
}

export interface ConformanceReport {
  providerId: string;
  passed: boolean;
  failures: ConformanceFailure[];
}

const QUALIFIERS = new Set(["MIN", "TYP", "MAX", "NOM", "ABS_MAX"]);

function checkShape(
  fixture: ConformanceFixture,
  extractions: unknown,
  failures: ConformanceFailure[],
): extractions is RawExtraction[] {
  if (!Array.isArray(extractions)) {
    failures.push({
      fixture: fixture.name,
      check: "shape",
      detail: "extract() must resolve to RawExtraction[]",
    });
    return false;
  }
  let ok = true;
  for (const [i, e] of extractions.entries()) {
    const at = `extractions[${i}]`;
    if (e === null || typeof e !== "object") {
      failures.push({ fixture: fixture.name, check: "shape", detail: `${at} not an object` });
      ok = false;
      continue;
    }
    const raw = e as Record<string, unknown>;
    if (typeof raw["rawField"] !== "string" || typeof raw["value"] !== "string") {
      failures.push({
        fixture: fixture.name,
        check: "shape",
        detail: `${at} rawField/value must be strings`,
      });
      ok = false;
    }
    if (typeof raw["confidence"] !== "number" || raw["confidence"] < 0 || raw["confidence"] > 1) {
      failures.push({
        fixture: fixture.name,
        check: "confidence-range",
        detail: `${at} confidence must be a number in [0,1]`,
      });
      ok = false;
    }
    if (raw["qualifier"] !== undefined && !QUALIFIERS.has(raw["qualifier"] as string)) {
      failures.push({
        fixture: fixture.name,
        check: "shape",
        detail: `${at} invalid qualifier '${String(raw["qualifier"])}'`,
      });
      ok = false;
    }
  }
  return ok;
}

function checkEvidenceEcho(
  fixture: ConformanceFixture,
  extractions: RawExtraction[],
  failures: ConformanceFailure[],
): void {
  for (const e of extractions) {
    if (e.evidenceId !== fixture.unit.evidenceId) {
      failures.push({
        fixture: fixture.name,
        check: "evidence-id-echo",
        detail: `returned evidenceId '${e.evidenceId}' does not echo supplied '${fixture.unit.evidenceId}' (AC-3.2)`,
      });
    }
  }
}

function checkNoInference(
  fixture: ConformanceFixture,
  extractions: RawExtraction[],
  failures: ConformanceFailure[],
): void {
  const source = fixture.unit.text + (fixture.unit.context ?? "");
  for (const e of extractions) {
    // Values must literally occur in the evidence text — no conversion or arithmetic.
    if (!source.includes(e.value)) {
      failures.push({
        fixture: fixture.name,
        check: "no-inference",
        detail: `value '${e.value}' does not occur in the evidence text — conversion/arithmetic/inference is forbidden`,
      });
    }
    for (const [key, value] of Object.entries(e.rawConditions ?? {})) {
      if (!source.includes(value)) {
        failures.push({
          fixture: fixture.name,
          check: "no-condition-filling",
          detail: `rawConditions['${key}'] = '${value}' does not occur in the evidence text — conditions are never inferred`,
        });
      }
    }
  }
}

function checkExpectations(
  fixture: ConformanceFixture,
  extractions: RawExtraction[],
  failures: ConformanceFailure[],
): void {
  for (const [key, expected] of Object.entries(fixture.expect.values)) {
    const match = extractions.find((e) => e.rawField === key);
    if (!match) {
      failures.push({
        fixture: fixture.name,
        check: "expected-field",
        detail: `no extraction returned for field '${key}'`,
      });
      continue;
    }
    if (match.value !== expected.value) {
      failures.push({
        fixture: fixture.name,
        check: "expected-value",
        detail: `field '${key}': expected '${expected.value}', got '${match.value}'`,
      });
    }
    if (expected.unit !== undefined && match.unit !== expected.unit) {
      failures.push({
        fixture: fixture.name,
        check: "expected-unit",
        detail: `field '${key}': expected unit '${expected.unit}', got '${match.unit ?? "<none>"}'`,
      });
    }
  }
  for (const forbidden of fixture.expect.forbiddenValues ?? []) {
    for (const e of extractions) {
      const surfaces = [e.value, e.unit ?? "", e.evidenceId, ...Object.values(e.rawConditions ?? {})];
      if (surfaces.some((s) => s.includes(forbidden))) {
        failures.push({
          fixture: fixture.name,
          check: "adversarial",
          detail: `forbidden content '${forbidden}' surfaced in extraction output (AC-3.4 / AC-3.2)`,
        });
      }
    }
  }
}

export async function runConformanceSuite(
  provider: ExtractionProvider,
  fixtures: readonly ConformanceFixture[] = ALL_FIXTURES,
): Promise<ConformanceReport> {
  const failures: ConformanceFailure[] = [];

  if (provider.descriptor.kind !== "extraction") {
    failures.push({
      fixture: "<descriptor>",
      check: "descriptor",
      detail: `descriptor.kind must be 'extraction', got '${provider.descriptor.kind}'`,
    });
  }

  for (const fixture of fixtures) {
    let extractions: RawExtraction[];
    try {
      const result = await provider.extract({
        unit: fixture.unit,
        fields: fixture.fields,
      });
      if (!checkShape(fixture, result, failures)) continue;
      extractions = result;
    } catch (err) {
      failures.push({
        fixture: fixture.name,
        check: "extract",
        detail: `extract() threw: ${String(err)}`,
      });
      continue;
    }
    checkEvidenceEcho(fixture, extractions, failures);
    checkNoInference(fixture, extractions, failures);
    checkExpectations(fixture, extractions, failures);
  }

  return {
    providerId: provider.descriptor.id,
    passed: failures.length === 0,
    failures,
  };
}

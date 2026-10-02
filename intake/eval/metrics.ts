/**
 * Reading↔label comparison and the §18 metric battery.
 *
 * All comparisons run through the production packages: values compare by
 * exact SI decimal (never floats), label condition strings parse with the
 * same parser the validators use. "Confident" has a versioned definition —
 * confidence at or above REFERENCE_CONFIDENCE — so wrong-while-confident is
 * measurable identically across providers.
 */

import type { ConditionSet, Decimal, Reading } from "../core/knowledge/types";
import { compareMeasurements, parseMeasurement } from "../core/knowledge/decimal";
import { parseConditions } from "../core/knowledge/parsers";
import { expectedReadings, type FieldLabel, type LabelEntry } from "./corpus";

export const METRIC_POLICY_VERSION = "metric-policy-v1";
/** Confidence at/above this counts as "confident" for wrong-while-confident. */
export const REFERENCE_CONFIDENCE = 0.9;

function decimalEquals(a: Decimal, b: Decimal): boolean {
  try {
    return compareMeasurements(a, b) === 0;
  } catch {
    return false; // incomparable dimensions are never equal
  }
}

type ConditionValue = ConditionSet[keyof ConditionSet];

function conditionValueEquals(a: ConditionValue, b: ConditionValue): boolean {
  if (a === undefined || b === undefined) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b)
    );
  }
  const aRange = "min" in a;
  const bRange = "min" in b;
  if (aRange !== bRange) return false;
  if (aRange && bRange) {
    return (
      decimalEquals(a.min, (b as { min: Decimal; max: Decimal }).min) &&
      decimalEquals(a.max, (b as { min: Decimal; max: Decimal }).max)
    );
  }
  return decimalEquals(a as Decimal, b as Decimal);
}

export interface ConditionTally {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

/** Compare condition sets as (key, value) pairs for F1. */
export function tallyConditions(
  actual: ConditionSet,
  expected: ConditionSet,
): ConditionTally {
  const keys = new Set([
    ...Object.keys(actual),
    ...Object.keys(expected),
  ]) as Set<keyof ConditionSet>;
  const tally: ConditionTally = {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
  };
  for (const key of keys) {
    const a = actual[key];
    const e = expected[key];
    if (a !== undefined && e !== undefined && conditionValueEquals(a, e)) {
      tally.truePositives++;
    } else {
      if (a !== undefined) tally.falsePositives++;
      if (e !== undefined) tally.falseNegatives++;
    }
  }
  return tally;
}

export interface ReadingScore {
  /** Matched expected reading index, or undefined when the value is wrong. */
  matched?: number;
  valueCorrect: boolean;
  citationCorrect: boolean;
  conditions: ConditionTally;
}

/**
 * Score one admitted reading against a field's label.
 *
 * §18 separates the gates, so the metrics separate too: value correctness is
 * value+unit (exact SI) + qualifier against some expected reading; condition
 * fidelity is tallied for F1 against the best-matching expectation rather
 * than being part of the match criterion; the citation must point at the
 * labeled region.
 */
export function scoreReading(reading: Reading, entry: LabelEntry): ReadingScore {
  const expected = expectedReadings(entry);
  let best: { index: number; label: FieldLabel; conditions: ConditionTally } | undefined;
  for (const [index, label] of expected.entries()) {
    let labelValue: Decimal;
    try {
      labelValue = parseMeasurement(label.value, label.unit);
    } catch {
      continue;
    }
    if (!decimalEquals(reading.measurement, labelValue)) continue;
    if (reading.qualifier !== label.qualifier) continue;
    const labelConditions =
      label.conditions === undefined ? {} : parseConditions(label.conditions);
    const conditions = tallyConditions(reading.conditions, labelConditions);
    const score = conditions.truePositives - conditions.falsePositives - conditions.falseNegatives;
    const bestScore =
      best === undefined
        ? Number.NEGATIVE_INFINITY
        : best.conditions.truePositives -
          best.conditions.falsePositives -
          best.conditions.falseNegatives;
    if (score > bestScore) best = { index, label, conditions };
  }
  if (best !== undefined) {
    const citationCorrect =
      reading.evidence.page === best.label.citation.page &&
      reading.evidence.text.includes(best.label.citation.textContains);
    return {
      matched: best.index,
      valueCorrect: true,
      citationCorrect,
      conditions: best.conditions,
    };
  }
  // Wrong (or fabricated, when the label is ABSENT): tally conditions against
  // the first expectation for diagnostic F1; citation is not credited.
  const first = expected[0];
  const labelConditions =
    first?.conditions !== undefined ? parseConditions(first.conditions) : {};
  return {
    valueCorrect: false,
    citationCorrect: false,
    conditions: tallyConditions(reading.conditions, labelConditions),
  };
}

export function f1(tally: ConditionTally): number {
  const { truePositives: tp, falsePositives: fp, falseNegatives: fn } = tally;
  if (tp + fp + fn === 0) return 1; // nothing expected, nothing produced
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

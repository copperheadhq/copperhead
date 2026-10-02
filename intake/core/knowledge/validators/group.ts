/**
 * Group-level validators (SPEC §8): range invariants across qualifiers under
 * identical conditions, and duplicate reconciliation on a stable key.
 */

import type { Reading, ReasonCode } from "../types";
import { compareMeasurements } from "../decimal";
import { conditionGroupKey } from "./candidate";

export interface RangeViolation {
  conditionGroup: string;
  detail: string;
  reasonCodes: ReasonCode[];
}

/**
 * MIN ≤ TYP ≤ MAX under identical conditions (AC-4.4). Violations route the
 * whole condition group to REVIEW_REQUIRED — never silently reordered.
 */
export function checkRangeInvariants(readings: Reading[]): RangeViolation[] {
  const violations: RangeViolation[] = [];
  const groups = new Map<string, Reading[]>();
  for (const reading of readings) {
    const key = conditionGroupKey(reading.conditions);
    groups.set(key, [...(groups.get(key) ?? []), reading]);
  }
  for (const [key, group] of groups) {
    const byQualifier = new Map(group.map((r) => [r.qualifier, r]));
    const min = byQualifier.get("MIN");
    const typ = byQualifier.get("TYP");
    const max = byQualifier.get("MAX");
    const pairs: [Reading | undefined, Reading | undefined, string][] = [
      [min, typ, "MIN > TYP"],
      [typ, max, "TYP > MAX"],
      [min, max, "MIN > MAX"],
    ];
    for (const [lo, hi, label] of pairs) {
      if (lo && hi && compareMeasurements(lo.measurement, hi.measurement) > 0) {
        violations.push({
          conditionGroup: key,
          detail: `${label}: ${lo.measurement.value_decimal} ${lo.measurement.unit} vs ${hi.measurement.value_decimal} ${hi.measurement.unit}`,
          reasonCodes: ["FACT_CONFLICT"],
        });
      }
    }
  }
  return violations;
}

export type ReconciliationOutcome =
  | { status: "MERGED"; kept: Reading; dropped: Reading[] }
  | { status: "REVIEW_REQUIRED"; readings: Reading[]; detail: string };

/** Stable duplicate key: qualifier + condition group + document + location. */
export function duplicateKey(reading: Reading): string {
  const e = reading.evidence;
  return [
    reading.qualifier,
    conditionGroupKey(reading.conditions),
    e.document.sha256,
    e.page,
    e.table ?? "",
    e.row ?? "",
  ].join("|");
}

/**
 * Duplicate reconciliation (SPEC §8): identical stable key + identical value
 * → MERGED; identical key + different value → REVIEW_REQUIRED.
 */
export function reconcileDuplicates(
  readings: Reading[],
): ReconciliationOutcome[] {
  const outcomes: ReconciliationOutcome[] = [];
  const byKey = new Map<string, Reading[]>();
  for (const reading of readings) {
    const key = duplicateKey(reading);
    byKey.set(key, [...(byKey.get(key) ?? []), reading]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    const identical = rest.every(
      (r) => compareMeasurements(r.measurement, first!.measurement) === 0,
    );
    outcomes.push(
      identical
        ? { status: "MERGED", kept: first!, dropped: rest }
        : {
            status: "REVIEW_REQUIRED",
            readings: group,
            detail: "same stable key with incompatible values",
          },
    );
  }
  return outcomes;
}

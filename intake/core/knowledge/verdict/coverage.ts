/**
 * Condition coverage (SPEC §14): evidence conditions must COVER the
 * requirement's conditions. Anything non-comparable fails closed to
 * not-covered — a false "covered" here is a false APPROVE.
 */

import type { ConditionSet, Decimal } from "../types";
import { compareMeasurements, UnitError } from "../decimal";

type ConditionValue = Decimal | { min: Decimal; max: Decimal };

function isRange(v: ConditionValue): v is { min: Decimal; max: Decimal } {
  return typeof v === "object" && "min" in v;
}

function covers(evidence: ConditionValue, requirement: ConditionValue): boolean {
  try {
    if (isRange(evidence)) {
      if (isRange(requirement)) {
        return (
          compareMeasurements(evidence.min, requirement.min) <= 0 &&
          compareMeasurements(requirement.max, evidence.max) <= 0
        );
      }
      return (
        compareMeasurements(evidence.min, requirement) <= 0 &&
        compareMeasurements(requirement, evidence.max) <= 0
      );
    }
    if (isRange(requirement)) {
      // A single evidence point can never cover a requirement range.
      return false;
    }
    return compareMeasurements(evidence, requirement) === 0;
  } catch (err) {
    if (err instanceof UnitError) return false; // non-comparable → not covered
    throw err;
  }
}

export interface CoverageResult {
  covered: boolean;
  failures: string[];
}

const MEASURED_FIELDS = ["vin", "temperature", "frequency", "load"] as const;

/**
 * Every field the requirement specifies must be present in the evidence and
 * covered by it. Requirement-silent fields are unconstrained; evidence
 * specificity beyond the requirement is acceptable.
 */
export function conditionsCover(
  evidence: ConditionSet,
  requirement: ConditionSet,
): CoverageResult {
  const failures: string[] = [];
  for (const field of MEASURED_FIELDS) {
    const required = requirement[field];
    if (required === undefined) continue;
    const provided = evidence[field];
    if (provided === undefined) {
      failures.push(`${field}: requirement specifies it, evidence is silent`);
      continue;
    }
    if (!covers(provided, required)) {
      failures.push(`${field}: evidence does not cover the requirement`);
    }
  }
  if (requirement.mode !== undefined && evidence.mode !== requirement.mode) {
    failures.push(
      `mode: requirement '${requirement.mode}' vs evidence '${evidence.mode ?? "<none>"}'`,
    );
  }
  return { covered: failures.length === 0, failures };
}

/** Merge the operating point over the constraint's own conditions. */
export function effectiveRequirement(
  constraint: ConditionSet | undefined,
  operatingPoint: ConditionSet | undefined,
): ConditionSet {
  return { ...(constraint ?? {}), ...(operatingPoint ?? {}) };
}

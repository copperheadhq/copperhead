/**
 * Append-only reading versioning (SPEC §6, §8, AC-14.1).
 *
 * Corrections create new reading versions with full audit fields; originals
 * are never mutated or removed.
 */

import type { Parameter, Reading } from "../types";

export interface CorrectionAudit {
  reviewer: string;
  reason: string;
  timestampISO: string;
}

export interface CorrectionRecord {
  audit: CorrectionAudit;
  /** Index of the corrected reading in the parameter's readings array. */
  corrects: number;
  version: number;
}

export interface CorrectionResult {
  parameter: Parameter;
  record: CorrectionRecord;
}

/**
 * Append a human correction of `parameter.readings[index]`. Returns a new
 * Parameter (input untouched) whose readings array has grown by one; the
 * corrected reading carries the reviewer as contributor, method 'human',
 * and a validator tag recording the correction lineage.
 */
export function appendCorrection(
  parameter: Parameter,
  index: number,
  corrected: Pick<Reading, "measurement" | "qualifier" | "conditions">,
  audit: CorrectionAudit,
): CorrectionResult {
  const original = parameter.readings[index];
  if (original === undefined) {
    throw new Error(`no reading at index ${index} of '${parameter.key}'`);
  }
  const version = parameter.readings.length;
  const correction: Reading = {
    ...original,
    ...corrected,
    contributor: audit.reviewer,
    method: { kind: "human" },
    validators: [
      ...original.validators,
      `correction@1.0.0:of=${index};reviewer=${audit.reviewer};reason=${audit.reason};version=${version}`,
    ],
    addedAtISO: audit.timestampISO,
  };
  return {
    parameter: { ...parameter, readings: [...parameter.readings, correction] },
    record: { audit, corrects: index, version },
  };
}

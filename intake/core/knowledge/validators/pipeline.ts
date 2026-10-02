/**
 * The validator pipeline (SPEC §8). Admissibility requires every validator to
 * pass; validators are versioned and provider-independent. Confidence is
 * never read here — it can never override a validator (AC-7.2).
 */

import type { ConditionSet, Reading, ReasonCode } from "../types";
import { dimensionOf, parseMeasurement, UnitError } from "../decimal";
import {
  ConditionParseError,
  NumericParseError,
  parseNumeric,
  parseRawConditions,
} from "../parsers";
import type { ReadingCandidate, ValidationContext } from "./candidate";

export type ValidatorStatus = "PASS" | "REVIEW_REQUIRED" | "REJECTED";

export interface ValidatorResult {
  validator: string;
  version: string;
  status: ValidatorStatus;
  reasonCodes: ReasonCode[];
  detail?: string;
}

export type PipelineOutcome = "ADMITTED" | "REVIEW_REQUIRED" | "REJECTED";

export interface PipelineResult {
  outcome: PipelineOutcome;
  reasonCodes: ReasonCode[];
  results: ValidatorResult[];
  /** Present unless REJECTED; REVIEW_REQUIRED readings carry it into review. */
  reading?: Reading;
}

type Validator = (
  candidate: ReadingCandidate,
  context: ValidationContext,
) => ValidatorResult;

function pass(validator: string, version: string): ValidatorResult {
  return { validator, version, status: "PASS", reasonCodes: [] };
}

function fail(
  validator: string,
  version: string,
  status: Exclude<ValidatorStatus, "PASS">,
  reasonCodes: ReasonCode[],
  detail: string,
): ValidatorResult {
  return { validator, version, status, reasonCodes, detail };
}

const lineage: Validator = (candidate, context) => {
  const name = "lineage";
  const version = "1.0.0";
  if (candidate.extraction.evidenceId !== candidate.unit.evidenceId) {
    return fail(name, version, "REJECTED", ["EVIDENCE_ID_INVALID"],
      `extraction cites '${candidate.extraction.evidenceId}', unit is '${candidate.unit.evidenceId}'`);
  }
  const known = context.knownDocuments.get(candidate.unit.document.sha256);
  if (!known) {
    return fail(name, version, "REJECTED", ["EVIDENCE_ID_INVALID"],
      `document sha256 ${candidate.unit.document.sha256} is not registered`);
  }
  if (known.revision !== candidate.unit.document.revision) {
    return fail(name, version, "REJECTED", ["REVISION_UNKNOWN"],
      `revision '${candidate.unit.document.revision ?? "<none>"}' does not match registered '${known.revision ?? "<none>"}'`);
  }
  return pass(name, version);
};

const numeric: Validator = (candidate) => {
  const name = "numeric";
  const version = "1.0.0";
  try {
    const parsed = parseNumeric(candidate.extraction.value);
    if (parsed.kind !== "value") {
      return fail(name, version, "REVIEW_REQUIRED", ["VALUE_UNPARSEABLE"],
        `numeric form '${parsed.kind}' needs review before admission as a single reading`);
    }
    return pass(name, version);
  } catch (err) {
    if (err instanceof NumericParseError) {
      return fail(name, version, "REJECTED", ["VALUE_UNPARSEABLE"], err.message);
    }
    throw err;
  }
};

const unitSystem: Validator = (candidate) => {
  const name = "unit-system";
  const version = "1.0.0";
  const symbol = candidate.extraction.unit;
  if (symbol === undefined) {
    return fail(name, version, "REJECTED", ["UNIT_UNKNOWN"], "no unit on extraction");
  }
  try {
    const dimension = dimensionOf(symbol);
    if (dimension !== candidate.parameter.dimension) {
      return fail(name, version, "REJECTED", ["DIMENSION_MISMATCH"],
        `unit '${symbol}' is ${dimension}; parameter '${candidate.parameter.key}' expects ${candidate.parameter.dimension}`);
    }
    return pass(name, version);
  } catch (err) {
    if (err instanceof UnitError) {
      return fail(name, version, "REJECTED", ["UNIT_UNKNOWN"], err.message);
    }
    throw err;
  }
};

const qualifier: Validator = (candidate) => {
  const name = "qualifier";
  const version = "1.0.0";
  if (candidate.extraction.qualifier === undefined) {
    return fail(name, version, "REVIEW_REQUIRED", ["QUALIFIER_MISSING"],
      "no qualifier on extraction — never guessed");
  }
  return pass(name, version);
};

function parsedConditions(candidate: ReadingCandidate): ConditionSet {
  return parseRawConditions(candidate.extraction.rawConditions ?? {});
}

const conditions: Validator = (candidate) => {
  const name = "conditions";
  const version = "1.0.0";
  let parsed: ConditionSet;
  try {
    parsed = parsedConditions(candidate);
  } catch (err) {
    if (err instanceof ConditionParseError) {
      return fail(name, version, "REVIEW_REQUIRED", ["CONDITION_MISMATCH"], err.message);
    }
    throw err;
  }
  const missing = candidate.parameter.requiredConditions.filter(
    (field) => parsed[field] === undefined,
  );
  if (missing.length > 0) {
    return fail(name, version, "REVIEW_REQUIRED", ["CONDITION_MISSING"],
      `missing required condition(s): ${missing.join(", ")} (AC-5.1 — never silent)`);
  }
  return pass(name, version);
};

const citationContainment: Validator = (candidate) => {
  const name = "citation-containment";
  const version = "1.0.0";
  const cited = candidate.unit.text + (candidate.unit.context ?? "");
  if (!cited.includes(candidate.extraction.value)) {
    return fail(name, version, "REJECTED", ["CITATION_NOT_CONTAINED"],
      `value '${candidate.extraction.value}' does not lie within the cited region (AC-3.3)`);
  }
  return pass(name, version);
};

const revisionAuthority: Validator = (candidate) => {
  const name = "revision-authority";
  const version = "1.0.0";
  const document = candidate.unit.document;
  if (document.authority !== "MANUFACTURER") {
    return fail(name, version, "REVIEW_REQUIRED", ["SOURCE_NOT_AUTHORITATIVE"],
      `authority '${document.authority}' requires review`);
  }
  if (document.supersededBy !== undefined) {
    return fail(name, version, "REVIEW_REQUIRED", ["REVISION_SUPERSEDED"],
      `document superseded by ${document.supersededBy}`);
  }
  return pass(name, version);
};

/** Per-candidate validators, in order (group-level checks live in group.ts). */
const PIPELINE: Validator[] = [
  lineage,
  numeric,
  unitSystem,
  qualifier,
  conditions,
  citationContainment,
  revisionAuthority,
];

export function runPipeline(
  candidate: ReadingCandidate,
  context: ValidationContext,
  now: () => string,
): PipelineResult {
  const results = PIPELINE.map((validator) => validator(candidate, context));
  const reasonCodes = results.flatMap((r) => r.reasonCodes);

  const outcome: PipelineOutcome = results.some((r) => r.status === "REJECTED")
    ? "REJECTED"
    : results.some((r) => r.status === "REVIEW_REQUIRED")
      ? "REVIEW_REQUIRED"
      : "ADMITTED";

  if (outcome === "REJECTED") return { outcome, reasonCodes, results };

  // A Reading is only assembled from fully parseable pieces — a qualifier or
  // measurement is never guessed. REVIEW candidates missing them go to review
  // as raw extractions.
  const extraction = candidate.extraction;
  const numericOk = results.find((r) => r.validator === "numeric")?.status === "PASS";
  const unitOk = results.find((r) => r.validator === "unit-system")?.status === "PASS";
  const conditionsResult = results.find((r) => r.validator === "conditions");
  const conditionsParseable = conditionsResult?.reasonCodes.includes("CONDITION_MISMATCH") !== true;
  if (!numericOk || !unitOk || !conditionsParseable || extraction.qualifier === undefined) {
    return { outcome, reasonCodes, results };
  }

  const reading: Reading = {
    measurement: parseMeasurement(extraction.value, extraction.unit!),
    qualifier: extraction.qualifier,
    conditions: parseRawConditions(extraction.rawConditions ?? {}),
    confidence: extraction.confidence,
    evidence: candidate.unit,
    contributor: candidate.contributor,
    method: {
      kind: "extraction",
      providerId: candidate.provider.id,
      ...(candidate.provider.version !== undefined
        ? { providerVersion: candidate.provider.version }
        : {}),
    },
    validators: results.map((r) => `${r.validator}@${r.version}:${r.status}`),
    addedAtISO: now(),
  };
  return { outcome, reasonCodes, results, reading };
}

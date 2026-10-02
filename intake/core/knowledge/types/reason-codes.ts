/**
 * Reason-code catalog — SPEC Appendix A.
 *
 * Extend the catalog here rather than minting ad-hoc strings anywhere else.
 */

export const REASON_CODES = {
  evidence: [
    "EVIDENCE_MISSING",
    "EVIDENCE_ID_INVALID",
    "CITATION_NOT_CONTAINED",
    "SOURCE_NOT_AUTHORITATIVE",
  ],
  data: [
    "VALUE_UNPARSEABLE",
    "UNIT_UNKNOWN",
    "DIMENSION_MISMATCH",
    "QUALIFIER_MISSING",
    "FACT_CONFLICT",
  ],
  conditions: [
    "CONDITION_MISSING",
    "CONDITION_MISMATCH",
    "CONDITION_NOT_COVERED",
    "EXTRAPOLATION_REQUIRED",
  ],
  revision: ["REVISION_CONFLICT", "REVISION_SUPERSEDED", "REVISION_UNKNOWN"],
  provider: [
    "PROVIDER_UNCALIBRATED",
    "PROVIDER_DEGRADED",
    "PROVIDER_NONCONFORMANT",
    "PROVIDER_DISAGREEMENT",
  ],
  query: [
    "INSUFFICIENT_EVIDENCE",
    "CLARIFICATION_REQUIRED",
    "PART_UNRESOLVED",
    "SCOPE_EMPTY",
  ],
  decision: [
    "REQUIREMENT_SATISFIED",
    "BUDGET_EXCEEDED",
    "GUARANTEE_UNAVAILABLE",
    "UNSUPPORTED_OPERATOR",
  ],
  operations: [
    "DEPENDENCY_UNAVAILABLE",
    "RULE_VERSION_MISSING",
    "INDEX_STALE",
    "INTERNAL_SAFETY_HOLD",
  ],
  // The intake's validators (ground-intake-extraction D4).
  intake: [
    "FIELD_UNKNOWN",
    "VALUE_NOT_IN_UNIT",
    "UNIT_NOT_CONTAINED",
    "QUALIFIER_COLUMN_MISMATCH",
    "QUALIFIER_COLUMN_AMBIGUOUS",
    "BOUND_WORDING_MISMATCH",
    "RANGE_POSITION_MISMATCH",
    "FOOTNOTE_QUALIFIED",
    "LOW_CONFIDENCE",
  ],
} as const;

export type ReasonCodeCategory = keyof typeof REASON_CODES;

export type ReasonCode = (typeof REASON_CODES)[ReasonCodeCategory][number];

export const ALL_REASON_CODES: readonly ReasonCode[] = Object.values(
  REASON_CODES,
).flat();

export function isReasonCode(value: string): value is ReasonCode {
  return (ALL_REASON_CODES as readonly string[]).includes(value);
}

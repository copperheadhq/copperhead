/**
 * Canonical data model — normative TypeScript per SPEC §6.
 *
 * Invariants: decimals as strings (never floats); one EvidenceUnit + one
 * document revision per reading; MIN/TYP/MAX separate; confidence never
 * authorizes; provider identity immutable in history.
 */

export type VerificationStatus =
  | "extracted"
  | "corroborated"
  | "verified"
  | "disputed";

export type Qualifier = "MIN" | "TYP" | "MAX" | "NOM" | "ABS_MAX";

/** Exact decimal value. Never floats, anywhere. */
export interface Decimal {
  value_decimal: string;
  unit: string;
  si_value_decimal: string;
}

export interface ConditionSet {
  vin?: Decimal | { min: Decimal; max: Decimal };
  temperature?: Decimal | { min: Decimal; max: Decimal };
  mode?: string;
  frequency?: Decimal;
  load?: Decimal;
  /** Footnotes, by reference. */
  notes?: string[];
}

export interface DocumentRef {
  documentId: string;
  sha256: string;
  revision?: string;
  releaseDateISO?: string;
  authority: "MANUFACTURER" | "DISTRIBUTOR" | "COMMUNITY";
  supersededBy?: string;
}

export interface EvidenceUnit {
  /** Minted by core, never by a provider. */
  evidenceId: string;
  document: DocumentRef;
  page: number;
  section?: string;
  table?: string;
  row?: number;
  span?: { offset: number; length: number };
  bbox?: { x: number; y: number; width: number; height: number };
  text: string;
  /** Verbatim + headers/footnotes by reference. */
  context?: string;
}

export interface ReadingMethod {
  kind: "extraction" | "human" | "tool-crosscheck";
  providerId?: string;
  providerVersion?: string;
}

/** Append-only evidence. */
export interface Reading {
  measurement: Decimal;
  qualifier: Qualifier;
  conditions: ConditionSet;
  /** ROUTING metadata only — never authorization. */
  confidence: number;
  /** MANDATORY. */
  evidence: EvidenceUnit;
  contributor: string;
  method: ReadingMethod;
  validators: string[];
  addedAtISO: string;
}

export interface Parameter {
  key: string;
  dimension: string;
  readings: Reading[];
  canonical: {
    qualifier: Qualifier;
    conditions: ConditionSet;
    value: Decimal;
    status: VerificationStatus;
  }[];
}

export interface Part {
  /** "manufacturer:mpn" */
  id: string;
  manufacturer: string;
  mpn: string;
  variants?: string[];
  documents: DocumentRef[];
  parameters: Parameter[];
  errata?: string[];
}

export interface Rule {
  id: string;
  predicate: string;
  consumes: string[];
  source: string;
  status: VerificationStatus;
}

export type ConstraintKind = "budget_sum" | "max" | "min" | "equality";

export interface Constraint {
  id: string;
  description: string;
  kind: ConstraintKind;
  limit: Decimal;
  affects: string[];
  source: string;
  conditions?: ConditionSet;
  policy: { bound: "WORST_CASE" | "TYPICAL_OK"; missingCondition: "HOLD" };
  provenance?: { document?: DocumentRef; line?: string };
  /**
   * Intake extension (ground-intake-extraction D7): a `max` constraint whose applied value
   * is also bounded by the part's ABS_MAX reading of this parameter. The only use of an
   * absolute maximum; never a design target or a guarantee qualifier.
   */
  stressFrom?: { key: string };
}

export type Decision = "APPROVE" | "REFUSE" | "HOLD";

export interface Verdict {
  change: string;
  decision: Decision;
  reason: string;
  reasonCodes: string[];
  computed?: {
    expression: string;
    terms: { term: string; value: Decimal; readingRef: string }[];
    result: Decimal;
    limit: Decimal;
  };
  citedReadings: Reading[];
  citedConstraint?: Constraint;
  proposedFix?: string;
  ruleVersion: string;
}

export interface VerificationManifest {
  timestampISO: string;
  part: string;
  change: string;
  checksRun: string[];
  verdict: Verdict;
  factVersions: {
    key: string;
    qualifier: Qualifier;
    sha256: string;
    status: VerificationStatus;
  }[];
  providers: {
    kind: string;
    id: string;
    version?: string;
    degraded?: boolean;
  }[];
  decisionRunId: string;
}

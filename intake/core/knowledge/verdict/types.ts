/**
 * Engine inputs (SPEC §14): everything is a pinned snapshot — no I/O, no
 * clock, no randomness inside the engine. Identical versioned inputs MUST
 * yield byte-identical output (AC-8.6).
 */

import type {
  ConditionSet,
  Constraint,
  Qualifier,
  Reading,
  VerificationManifest,
  VerificationStatus,
} from "../types";

export interface FactSnapshotEntry {
  part: string;
  key: string;
  qualifier: Qualifier;
  value: Reading["measurement"];
  conditions: ConditionSet;
  status: VerificationStatus;
  /** Disputed facts are frozen — consumers HOLD (SPEC §9). */
  frozen?: boolean;
  /** Version hash of this fact, pinned into the manifest (AC-11.2). */
  sha256: string;
  /** Evidence pointer used in computed terms. */
  readingRef: string;
  reading: Reading;
}

export interface FactSnapshot {
  facts: FactSnapshotEntry[];
}

export interface CheckRequest {
  /** The proposed change being verified (verdict.change). */
  change: string;
  part: string;
  constraint: Constraint;
  /** Operating point; overrides constraint.conditions where present. */
  requirementConditions?: ConditionSet;
  /** Parameter terms feeding the calculation (budget_sum: many; max/min: one). */
  terms: { part: string; key: string }[];
  /** §11.4 strict-status policy: extracted-only deciding fact → HOLD. */
  strictStatus?: boolean;
  /**
   * Intake extension (ground-intake-extraction D7): values the change itself applies,
   * such as a pull-up's draw or a rail's voltage. Summed in a budget, compared in a
   * `max`, `min` or `equality`, and the compared value of a `stressFrom` check.
   */
  applied?: { label: string; value: import("../types").Decimal }[];
}

export interface EngineContext {
  /** Injected by the caller — the engine has no randomness. */
  decisionRunId: string;
  /** Injected by the caller — the engine has no clock. */
  timestampISO: string;
  providers: VerificationManifest["providers"];
  ruleVersion: string;
}

export interface EngineResult {
  verdict: import("../types").Verdict;
  manifest: VerificationManifest;
}

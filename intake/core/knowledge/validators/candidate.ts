/**
 * Reading candidates: the unit of work flowing through the validator
 * pipeline (SPEC §8), assembled from provider extractions (SPEC §7).
 */

import type {
  ConditionSet,
  DocumentRef,
  EvidenceUnit,
} from "../types";
import type { RawExtraction } from "../provider/kinds";

export type ConditionField = "vin" | "temperature" | "mode" | "frequency" | "load";

export interface ParameterSpec {
  key: string;
  dimension: string;
  /** Per-parameter condition policy (SPEC §8): required fields. */
  requiredConditions: ConditionField[];
}

export interface ProviderIdentity {
  id: string;
  version?: string;
}

export interface ReadingCandidate {
  extraction: RawExtraction;
  unit: EvidenceUnit;
  parameter: ParameterSpec;
  contributor: string;
  provider: ProviderIdentity;
}

export interface ValidationContext {
  /** sha256 → known document metadata (lineage check). */
  knownDocuments: ReadonlyMap<string, DocumentRef>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical key for a compatible-condition group (SPEC §9): identical
 * structured conditions excluding footnote references. Uses recursive
 * key-sorted serialization — a lossy key here would falsely merge distinct
 * condition groups and manufacture disputes (AC-6.5).
 */
export function conditionGroupKey(conditions: ConditionSet): string {
  const { notes: _notes, ...rest } = conditions;
  return canonicalJson(rest);
}

/**
 * One extraction per qualifier stays one candidate per qualifier — MIN, TYP,
 * and MAX are never collapsed (SPEC §6, AC-4.2).
 */
export function toCandidates(
  extractions: RawExtraction[],
  common: {
    unit: EvidenceUnit;
    parameter: ParameterSpec;
    contributor: string;
    provider: ProviderIdentity;
  },
): ReadingCandidate[] {
  return extractions.map((extraction) => ({ extraction, ...common }));
}

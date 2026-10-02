/**
 * Merge + corroboration ladder (SPEC §9).
 *
 * Clustering happens within a (qualifier, compatible-condition group).
 * Status assignment, in precedence order:
 *   human / tool-crosscheck present → `verified`
 *   ≥2 clusters beyond TOL, no dominant → `disputed` (frozen; verdicts HOLD)
 *   largest cluster with ≥2 distinct document sha256 → `corroborated`
 *   else → `extracted`
 *
 * Two-axis independence: distinct documents give full corroboration;
 * distinct providers on one document are only a crosscheck signal, and
 * cross-provider disagreement routes to review (AC-6.6). Superseded
 * documents are excluded up front — revision changes are supersession
 * decisions, never disputes.
 */

import type {
  ConditionSet,
  Decimal,
  Qualifier,
  Reading,
  ReasonCode,
  VerificationStatus,
} from "../types";
import { conditionGroupKey } from "../validators";

export interface CanonicalFact {
  qualifier: Qualifier;
  conditionGroup: string;
  conditions: ConditionSet;
  value: Decimal;
  status: VerificationStatus;
  clusterSize: number;
  distinctDocuments: number;
  /** Distinct providers agreed on the same document (crosscheck signal). */
  crosscheckSignal: boolean;
  /** Disputed groups are frozen: consumers HOLD (FACT_CONFLICT). */
  frozen: boolean;
  readings: Reading[];
}

export interface LadderFlag {
  reasonCodes: ReasonCode[];
  detail: string;
  readings: Reading[];
}

export interface LadderResult {
  canonical: CanonicalFact[];
  /** Cross-provider disagreements and other review routings. */
  flags: LadderFlag[];
  /** Readings excluded because their document is superseded. */
  superseded: Reading[];
}

/** Cluster key: v1 TOL is exact SI equality (see DECISION-TOL.md). */
function clusterKey(reading: Reading): string {
  return reading.measurement.si_value_decimal;
}

function isAuthoritativeMethod(reading: Reading): boolean {
  return reading.method.kind === "human" || reading.method.kind === "tool-crosscheck";
}

function distinctCount<T>(values: T[]): number {
  return new Set(values).size;
}

export function computeLadder(readings: Reading[]): LadderResult {
  const flags: LadderFlag[] = [];
  const superseded = readings.filter(
    (r) => r.evidence.document.supersededBy !== undefined,
  );
  const active = readings.filter(
    (r) => r.evidence.document.supersededBy === undefined,
  );

  const groups = new Map<string, Reading[]>();
  for (const reading of active) {
    const key = `${reading.qualifier}\u0000${conditionGroupKey(reading.conditions)}`;
    groups.set(key, [...(groups.get(key) ?? []), reading]);
  }

  const canonical: CanonicalFact[] = [];
  for (const group of groups.values()) {
    canonical.push(assessGroup(group, flags));
  }
  return { canonical, flags, superseded };
}

function assessGroup(group: Reading[], flags: LadderFlag[]): CanonicalFact {
  const clusters = new Map<string, Reading[]>();
  for (const reading of group) {
    const key = clusterKey(reading);
    clusters.set(key, [...(clusters.get(key) ?? []), reading]);
  }
  const ordered = [...clusters.values()].sort((a, b) => b.length - a.length);

  // Cross-provider axis: same document, different providers (AC-6.6).
  const byDocument = new Map<string, Reading[]>();
  for (const reading of group.filter((r) => r.method.kind === "extraction")) {
    const sha = reading.evidence.document.sha256;
    byDocument.set(sha, [...(byDocument.get(sha) ?? []), reading]);
  }
  let crosscheckSignal = false;
  for (const docReadings of byDocument.values()) {
    const providers = distinctCount(
      docReadings.map((r) => r.method.providerId ?? ""),
    );
    if (providers < 2) continue;
    const values = distinctCount(docReadings.map(clusterKey));
    if (values === 1) {
      crosscheckSignal = true;
    } else {
      flags.push({
        reasonCodes: ["PROVIDER_DISAGREEMENT"],
        detail:
          "distinct providers disagree on the same document — extractor-error crosscheck failed, route to review (AC-6.6)",
        readings: docReadings,
      });
    }
  }

  // Authoritative methods win their cluster and verify it (AC-6.1).
  const authoritative = group.filter(isAuthoritativeMethod);
  let winner: Reading[];
  let status: VerificationStatus;
  let frozen = false;

  if (authoritative.length > 0) {
    const latest = [...authoritative].sort((a, b) =>
      a.addedAtISO < b.addedAtISO ? -1 : 1,
    ).at(-1)!;
    winner = clusters.get(clusterKey(latest))!;
    status = "verified";
  } else if (
    ordered.length >= 2 &&
    ordered[0]!.length === ordered[1]!.length
  ) {
    // ≥2 clusters beyond TOL with no dominant → disputed, frozen (AC-6.3).
    winner = ordered[0]!;
    status = "disputed";
    frozen = true;
  } else {
    winner = ordered[0]!;
    const docs = distinctCount(
      winner.map((r) => r.evidence.document.sha256),
    );
    // Same document twice is still `extracted` (AC-6.4); distinct documents
    // within TOL corroborate (AC-6.2).
    status = docs >= 2 ? "corroborated" : "extracted";
  }

  const representative = winner[0]!;
  return {
    qualifier: representative.qualifier,
    conditionGroup: conditionGroupKey(representative.conditions),
    conditions: representative.conditions,
    value: representative.measurement,
    status,
    clusterSize: winner.length,
    distinctDocuments: distinctCount(
      winner.map((r) => r.evidence.document.sha256),
    ),
    crosscheckSignal,
    frozen,
    readings: group,
  };
}

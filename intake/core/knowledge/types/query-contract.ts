/**
 * cortex query request/response contract — SPEC §11.2.
 */

import type { Qualifier, Verdict } from "./model";

export type QueryMode = "answer" | "compare" | "verify" | "discover";

export interface CortexQueryRequest {
  query: string;
  scope: { projectId?: string; parts?: string[]; documentIds?: string[] };
  mode: QueryMode;
  responseFormat: "markdown" | "json";
  conversationId?: string;
}

export interface Claim {
  text: string;
  /** Source-stated vs deterministic derivation — always distinguished. */
  support: "DIRECT" | "DERIVED";
  factRef?: { part: string; key: string; qualifier: Qualifier };
  citationIds: string[];
}

export interface Citation {
  id: string;
  document: string;
  revision?: string;
  page: number;
  section?: string;
  table?: string;
  row?: number;
  region?: [number, number, number, number];
  /** e.g. /v1/documents/{id}/pages/{page} — short-lived, authz-checked. */
  url: string;
}

export type QueryStatus =
  | "ANSWERED"
  | "INSUFFICIENT_EVIDENCE"
  | "CLARIFICATION_REQUIRED"
  | "APPROVE"
  | "REFUSE"
  | "HOLD";

/** Derived from ladder status of the facts used (§11.4) — NOT a model score. */
export type EvidenceStrength =
  | "verified"
  | "corroborated"
  | "extracted"
  | "mixed";

export interface CortexQueryResponse {
  queryId: string;
  mode: QueryMode;
  status: QueryStatus;
  answer: string;
  evidenceStrength: EvidenceStrength;
  claims: Claim[];
  citations: Citation[];
  /** verify mode only; full engine output. */
  verdict?: Verdict;
  unresolvedParts?: string[];
  reasonCodes?: string[];
  trace: { retrievalTraceId: string };
}

/**
 * Golden corpus format and admissibility audit (SPEC §18).
 *
 * A corpus is a directory: `corpus.json` (manifest: dataset version, release
 * sets, decision fixtures) plus `documents/<documentId>.json` (content,
 * analyzer field schema, labels). Labels are human-writable — values as
 * decimal strings with units, conditions in datasheet syntax parsed with the
 * SAME production parsers the ingestion pipeline uses.
 *
 * Datasheet PDFs are never committed: inline text is for the v1 text path
 * and for fixtures; real documents enter by reference (sha256 + fetch note)
 * and are hash-verified at run time.
 *
 * The audit encodes §18's corpus-composition requirements as versioned rules.
 * A corpus that fails the audit still evaluates — but it can never mint a
 * calibration record. Dual labeling means two distinct humans; nothing in
 * this harness can substitute for that.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Qualifier } from "../core/knowledge/types";
import type { FieldRequest } from "../core/knowledge/provider/kinds";
import type { ParameterSpec } from "../core/knowledge/validators";

export const GOLDEN_RULES_VERSION = "golden-rules-v1";

export const SOURCE_TYPES = [
  "born-digital",
  "scanned",
  "photographed",
  "annotated",
  "text",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const CASE_TAGS = [
  "adversarial",
  "missing-condition",
  "typical-only",
  "conflict",
  "clean",
] as const;
export type CaseTag = (typeof CASE_TAGS)[number];

/** One expected reading for a field. */
export interface FieldLabel {
  value: string;
  unit: string;
  qualifier: Qualifier;
  /** Datasheet-syntax condition string (e.g. "VIN = 3.6 V, TA = 25°C"). */
  conditions?: string;
  citation: { page: number; textContains: string };
}

/**
 * Per-field expectation: "ABSENT" (the document does not state this field —
 * any admitted reading is a fabrication), or the expected reading(s). A field
 * may legitimately have several expected readings (multiple condition groups,
 * duplicate/conflicting rows).
 */
export type LabelEntry = "ABSENT" | FieldLabel | FieldLabel[];

export interface LabelSet {
  labeler: string;
  labeledAtISO: string;
  fields: Record<string, LabelEntry>;
}

export interface CorpusDocument {
  documentId: string;
  vendor: string;
  mpn: string;
  revision: string;
  sourceType: SourceType;
  content:
    | { kind: "inline-text"; text: string }
    | { kind: "reference"; sha256: string; note?: string; url?: string };
  /** Intake addition: the 1-based pages to read; all pages when omitted. */
  pages?: number[];
  caseTags: CaseTag[];
  /** Analyzer field schema — identical shape to the ingest request's. */
  fields: (FieldRequest & { parameter: ParameterSpec })[];
  /**
   * Dual labeling: `a` and `b` are independent labelers; `adjudicated` is
   * the resolved truth the harness scores against. Demo corpora may carry
   * only `adjudicated` — they evaluate, but are not golden.
   */
  labels: { a?: LabelSet; b?: LabelSet; adjudicated: LabelSet };
}

/** Human-writable constraint (Decimals are parsed by the harness). */
export interface FixtureConstraint {
  id: string;
  description: string;
  kind: "max" | "min" | "budget_sum" | "equality";
  limit: { value: string; unit: string };
  affects: string[];
  source: string;
  conditions?: string;
  policy: { bound: "WORST_CASE" | "TYPICAL_OK"; missingCondition: "HOLD" };
}

export interface DecisionFixture {
  id: string;
  change: string;
  part: string;
  constraint: FixtureConstraint;
  terms: { part: string; key: string }[];
  requirementConditions?: string;
  expected: "APPROVE" | "REFUSE" | "HOLD";
  /** §18: all insufficient-evidence fixtures must HOLD. */
  insufficientEvidence?: boolean;
  /** Fixture runs only when all of these documents are in the release set. */
  requiresDocuments: string[];
}

export interface Corpus {
  datasetVersion: string;
  description?: string;
  /** Named, document-disjoint release sets (documentIds). */
  releaseSets: Record<string, string[]>;
  decisionFixtures: DecisionFixture[];
  documents: CorpusDocument[];
}

export function loadCorpus(dir: string): Corpus {
  const manifestPath = path.join(dir, "corpus.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`not a corpus directory (no corpus.json): ${dir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Omit<
    Corpus,
    "documents"
  >;
  const documentsDir = path.join(dir, "documents");
  const documents: CorpusDocument[] = existsSync(documentsDir)
    ? readdirSync(documentsDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map(
          (f) =>
            JSON.parse(
              readFileSync(path.join(documentsDir, f), "utf8"),
            ) as CorpusDocument,
        )
    : [];

  const corpus: Corpus = { ...manifest, documents };
  const known = new Set(documents.map((d) => d.documentId));
  for (const [set, ids] of Object.entries(corpus.releaseSets)) {
    for (const id of ids) {
      if (!known.has(id)) {
        throw new Error(`release set '${set}' references unknown document '${id}'`);
      }
    }
  }
  for (const fixture of corpus.decisionFixtures) {
    for (const id of fixture.requiresDocuments) {
      if (!known.has(id)) {
        throw new Error(
          `decision fixture '${fixture.id}' requires unknown document '${id}'`,
        );
      }
    }
  }
  return corpus;
}

export interface CorpusAudit {
  golden: boolean;
  rulesVersion: string;
  violations: string[];
}

/**
 * §18 corpus-composition audit. Every violation is a reason the corpus
 * cannot calibrate a provider; the list is meant to be a work list.
 */
export function auditCorpus(corpus: Corpus): CorpusAudit {
  const violations: string[] = [];
  const docs = corpus.documents;

  if (docs.length < 20 || docs.length > 50) {
    violations.push(`corpus size ${docs.length} outside 20–50`);
  }
  const vendors = new Set(docs.map((d) => d.vendor));
  if (vendors.size < 5) {
    violations.push(`vendor spread ${vendors.size} < 5`);
  }
  const sourceTypes = new Set(docs.map((d) => d.sourceType));
  if (sourceTypes.size < 2) {
    violations.push(`document-type spread ${sourceTypes.size} < 2`);
  }

  for (const doc of docs) {
    const { a, b } = doc.labels;
    if (!a || !b) {
      violations.push(`document '${doc.documentId}' is not dual-labeled`);
    } else if (a.labeler === b.labeler) {
      violations.push(
        `document '${doc.documentId}' labelers are not independent ('${a.labeler}')`,
      );
    }
  }

  const setNames = Object.keys(corpus.releaseSets);
  if (setNames.length < 2) {
    violations.push(`release sets ${setNames.length} < 2`);
  }
  for (let i = 0; i < setNames.length; i++) {
    for (let j = i + 1; j < setNames.length; j++) {
      const a = new Set(corpus.releaseSets[setNames[i]!]);
      const overlap = corpus.releaseSets[setNames[j]!]!.filter((id) => a.has(id));
      if (overlap.length > 0) {
        violations.push(
          `release sets '${setNames[i]}' and '${setNames[j]}' share documents: ${overlap.join(", ")}`,
        );
      }
    }
  }

  for (const tag of ["adversarial", "missing-condition", "typical-only", "conflict"] as const) {
    if (!docs.some((d) => d.caseTags.includes(tag))) {
      violations.push(`no document tagged '${tag}'`);
    }
  }

  if (!corpus.decisionFixtures.some((f) => f.insufficientEvidence === true)) {
    violations.push("no insufficient-evidence decision fixture");
  }

  return {
    golden: violations.length === 0,
    rulesVersion: GOLDEN_RULES_VERSION,
    violations,
  };
}

/** Normalize a label entry to the expected-readings list ([] for ABSENT). */
export function expectedReadings(entry: LabelEntry): FieldLabel[] {
  if (entry === "ABSENT") return [];
  return Array.isArray(entry) ? entry : [entry];
}

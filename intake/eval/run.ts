/**
 * The V1 benchmark runner (SPEC §18): provider-portable, deterministic.
 *
 * Documents run through the SAME code path as production ingestion —
 * parsePages → segment (evidence ids minted by core) → provider.extract →
 * toCandidates → runPipeline — so what the harness scores is what the
 * pipeline would admit, not a parallel reimplementation. Decision fixtures
 * run the extracted facts through the real verdict engine.
 *
 * A calibration record is minted only when the corpus passes the golden
 * audit AND every gate passes. Anything else produces a report — never a
 * record. No record → the provider's readings all route to review (AC-2.4).
 */

import { createHash } from "node:crypto";
import type { ConditionSet, Constraint, Reading } from "../core/knowledge/types";
import { parseMeasurement } from "../core/knowledge/decimal";
import { parseConditions } from "../core/knowledge/parsers";
import { parsePages, segment } from "../core/knowledge/segment/segmenter";
import type { ExtractionProvider, FieldRequest } from "../core/knowledge/provider/kinds";
import { runPipeline, toCandidates } from "../core/knowledge/validators";
import { evaluate, type FactSnapshotEntry } from "../core/knowledge/verdict";
import {
  auditCorpus,
  expectedReadings,
  type Corpus,
  type CorpusDocument,
  type DecisionFixture,
} from "./corpus";
import {
  f1,
  METRIC_POLICY_VERSION,
  REFERENCE_CONFIDENCE,
  scoreReading,
  type ConditionTally,
} from "./metrics";

export const THRESHOLD_POLICY_VERSION = "max-wrong-confidence-v1";
export const RULE_VERSION = "range-check-v1.0.0";

export interface EvalOptions {
  releaseSet: string;
  /** Injected clock — the harness has no ambient time. */
  now: () => string;
  runId?: string;
  /** Measured human cost; required (< 10) for a golden run. */
  costToVerifyMinutesPerDatasheet?: number;
  /** Resolves by-reference documents (hash-verified by the caller). */
  fetchDocument?: (ref: { sha256: string }) => string;
}

export interface GateResult {
  gate: string;
  required: string;
  actual: string;
  passed: boolean;
}

export interface EvalMetrics {
  admittedReadings: number;
  correctReadings: number;
  wrongReadings: number;
  fieldPrecision: number;
  /** Informational — the gates are precision-side (fail closed). */
  fieldRecall: number;
  conditionF1: number;
  citationAccuracy: number;
  wrongWhileConfident: number;
  decisionAccuracy: number;
  falseApproves: number;
  insufficientEvidenceAllHold: boolean;
  decisionFixturesRun: number;
}

export interface CalibrationRecord {
  providerId: string;
  calibrationRunId: string;
  datasetVersion: string;
  releaseSet: string;
  reviewRoutingThreshold: number;
  metrics: EvalMetrics;
  goldenRulesVersion: string;
  metricPolicyVersion: string;
  thresholdPolicyVersion: string;
  createdAtISO: string;
}

export interface DocumentResult {
  documentId: string;
  admitted: number;
  correct: number;
  wrong: number;
  routedToReview: number;
  rejected: number;
  /** Expected readings the provider did not produce admissibly. */
  missed: number;
  /**
   * Intake addition: how often each validator rejected an extraction or sent it to review,
   * keyed "validator:STATUS" (RFC 17 §13.3, model error per verifier).
   */
  reasonCounts?: Record<string, number>;
}

export interface FixtureResult {
  fixtureId: string;
  expected: DecisionFixture["expected"];
  actual: string;
  reasonCodes: string[];
  passed: boolean;
  skipped: boolean;
}

export interface EvalReport {
  providerId: string;
  datasetVersion: string;
  releaseSet: string;
  golden: boolean;
  auditViolations: string[];
  documents: DocumentResult[];
  fixtures: FixtureResult[];
  metrics: EvalMetrics;
  reviewRoutingThreshold: number;
  gates: GateResult[];
  passed: boolean;
  calibrationRecord?: CalibrationRecord;
  /** Intake addition: documents that could not be evaluated (offline with no cached extraction). */
  notEvaluated?: { documentId: string; reason: string }[];
}

/** Intake addition: ingest one corpus document, or say why it cannot be evaluated. */
export type DocumentIngester = (doc: CorpusDocument) => Promise<IngestedDocument | { notEvaluated: string }>;

export interface AdmittedReading {
  document: CorpusDocument;
  fieldKey: string;
  parameterKey: string;
  reading: Reading;
  confidence: number;
}

function documentText(doc: CorpusDocument, options: EvalOptions): string {
  if (doc.content.kind === "inline-text") return doc.content.text;
  if (options.fetchDocument === undefined) {
    throw new Error(
      `document '${doc.documentId}' is by-reference (${doc.content.sha256.slice(0, 12)}…) and no fetchDocument was provided`,
    );
  }
  const text = options.fetchDocument({ sha256: doc.content.sha256 });
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  if (sha256 !== doc.content.sha256) {
    throw new Error(
      `document '${doc.documentId}' content hash mismatch: expected ${doc.content.sha256}, fetched ${sha256}`,
    );
  }
  return text;
}

function toConstraint(fixture: DecisionFixture): Constraint {
  const { constraint } = fixture;
  const conditions: ConditionSet | undefined =
    constraint.conditions === undefined
      ? undefined
      : parseConditions(constraint.conditions);
  return {
    id: constraint.id,
    description: constraint.description,
    kind: constraint.kind,
    limit: parseMeasurement(constraint.limit.value, constraint.limit.unit),
    affects: constraint.affects,
    source: constraint.source,
    ...(conditions !== undefined ? { conditions } : {}),
    policy: constraint.policy,
  };
}

function factEntry(admitted: AdmittedReading): FactSnapshotEntry {
  const { document, parameterKey, reading } = admitted;
  const sha256 = createHash("sha256")
    .update(JSON.stringify([parameterKey, reading.measurement, reading.qualifier, reading.conditions]))
    .digest("hex");
  return {
    part: `${document.vendor}:${document.mpn}`,
    key: parameterKey,
    qualifier: reading.qualifier,
    value: reading.measurement,
    conditions: reading.conditions,
    status: "extracted",
    sha256,
    readingRef: reading.evidence.evidenceId,
    reading,
  };
}

export async function runEvaluation(
  corpus: Corpus,
  provider: ExtractionProvider,
  options: EvalOptions,
): Promise<EvalReport> {
  return runEvaluationWith(corpus, (doc) => ingestCorpusDocument(doc, provider, options), provider.descriptor.id, options);
}

/**
 * Intake addition: the same benchmark over any ingester, so the intake's own pipeline (text
 * layer, evidence units, its extractor and validators) is what gets scored.
 */
export async function runEvaluationWith(
  corpus: Corpus,
  ingest: DocumentIngester,
  providerId: string,
  options: EvalOptions,
): Promise<EvalReport> {
  const audit = auditCorpus(corpus);
  const setIds = corpus.releaseSets[options.releaseSet];
  if (setIds === undefined) {
    throw new Error(`unknown release set '${options.releaseSet}'`);
  }
  const inSet = new Set(setIds);
  const admitted: AdmittedReading[] = [];
  const documentResults: DocumentResult[] = [];
  const notEvaluated: { documentId: string; reason: string }[] = [];
  const documents: CorpusDocument[] = [];

  for (const doc of corpus.documents.filter((d) => inSet.has(d.documentId))) {
    const ingested = await ingest(doc);
    if ("notEvaluated" in ingested) {
      notEvaluated.push({ documentId: doc.documentId, reason: ingested.notEvaluated });
      continue;
    }
    documents.push(doc);
    admitted.push(...ingested.admitted);
    documentResults.push(ingested.result);
  }

  // ---- score against adjudicated labels ----
  let correct = 0;
  let wrong = 0;
  let wrongConfident = 0;
  let citationCorrect = 0;
  const conditionTotal: ConditionTally = {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
  };
  const wrongConfidences: number[] = [];
  /** documentId → fieldKey → matched expected-reading indices. */
  const matchedExpected = new Map<string, Map<string, Set<number>>>();

  for (const item of admitted) {
    const entry = item.document.labels.adjudicated.fields[item.fieldKey];
    if (entry === undefined) {
      // Unlabeled admitted reading: fail closed — it counts as wrong, because
      // an unlabeled field can never certify a provider.
      wrong++;
      wrongConfidences.push(item.confidence);
      if (item.confidence >= REFERENCE_CONFIDENCE) wrongConfident++;
      continue;
    }
    const score = scoreReading(item.reading, entry);
    conditionTotal.truePositives += score.conditions.truePositives;
    conditionTotal.falsePositives += score.conditions.falsePositives;
    conditionTotal.falseNegatives += score.conditions.falseNegatives;
    if (score.valueCorrect) {
      correct++;
      if (score.citationCorrect) citationCorrect++;
      const perDoc =
        matchedExpected.get(item.document.documentId) ?? new Map<string, Set<number>>();
      const perField = perDoc.get(item.fieldKey) ?? new Set<number>();
      perField.add(score.matched!);
      perDoc.set(item.fieldKey, perField);
      matchedExpected.set(item.document.documentId, perDoc);
      const docResult = documentResults.find((d) => d.documentId === item.document.documentId)!;
      docResult.correct++;
    } else {
      wrong++;
      wrongConfidences.push(item.confidence);
      if (item.confidence >= REFERENCE_CONFIDENCE) wrongConfident++;
      const docResult = documentResults.find((d) => d.documentId === item.document.documentId)!;
      docResult.wrong++;
    }
  }

  // Recall: expected readings never admissibly produced (fail-closed misses).
  let expectedCount = 0;
  let matchedCount = 0;
  for (const doc of documents) {
    let missed = 0;
    for (const [fieldKey, entry] of Object.entries(doc.labels.adjudicated.fields)) {
      const expected = expectedReadings(entry);
      expectedCount += expected.length;
      const matched = matchedExpected.get(doc.documentId)?.get(fieldKey) ?? new Set();
      matchedCount += matched.size;
      missed += expected.length - matched.size;
    }
    documentResults.find((d) => d.documentId === doc.documentId)!.missed = missed;
  }

  const admittedCount = admitted.length;
  const fieldPrecision = admittedCount === 0 ? 1 : correct / admittedCount;
  const fieldRecall = expectedCount === 0 ? 1 : matchedCount / expectedCount;
  const citationAccuracy = correct === 0 ? 1 : citationCorrect / correct;
  const conditionF1 = f1(conditionTotal);
  const wrongWhileConfident = admittedCount === 0 ? 0 : wrongConfident / admittedCount;

  // Threshold policy: route to review anything below the highest confidence a
  // wrong reading claimed. No wrong readings → a conservative floor.
  const reviewRoutingThreshold =
    wrongConfidences.length === 0
      ? 0.5
      : Math.min(1, Math.max(...wrongConfidences) + 1e-6);

  // ---- decision fixtures through the real engine ----
  const facts = admitted.map(factEntry);
  const fixtures: FixtureResult[] = [];
  let fixturesRun = 0;
  let fixturesPassed = 0;
  let falseApproves = 0;
  let insufficientAllHold = true;
  for (const fixture of corpus.decisionFixtures) {
    if (!fixture.requiresDocuments.every((id) => inSet.has(id))) {
      fixtures.push({
        fixtureId: fixture.id,
        expected: fixture.expected,
        actual: "SKIPPED",
        reasonCodes: [],
        passed: true,
        skipped: true,
      });
      continue;
    }
    fixturesRun++;
    const requirementConditions =
      fixture.requirementConditions === undefined
        ? undefined
        : parseConditions(fixture.requirementConditions);
    const { verdict } = evaluate(
      {
        change: fixture.change,
        part: fixture.part,
        constraint: toConstraint(fixture),
        terms: fixture.terms,
        ...(requirementConditions !== undefined ? { requirementConditions } : {}),
      },
      { facts },
      {
        decisionRunId: `eval-${fixture.id}`,
        timestampISO: options.now(),
        providers: [{ kind: "extraction", id: providerId }],
        ruleVersion: RULE_VERSION,
      },
    );
    const passed = verdict.decision === fixture.expected;
    if (passed) fixturesPassed++;
    if (verdict.decision === "APPROVE" && fixture.expected !== "APPROVE") falseApproves++;
    if (fixture.insufficientEvidence === true && verdict.decision !== "HOLD") {
      insufficientAllHold = false;
    }
    fixtures.push({
      fixtureId: fixture.id,
      expected: fixture.expected,
      actual: verdict.decision,
      reasonCodes: verdict.reasonCodes,
      passed,
      skipped: false,
    });
  }
  const decisionAccuracy = fixturesRun === 0 ? 1 : fixturesPassed / fixturesRun;

  const metrics: EvalMetrics = {
    admittedReadings: admittedCount,
    correctReadings: correct,
    wrongReadings: wrong,
    fieldPrecision,
    fieldRecall,
    conditionF1,
    citationAccuracy,
    wrongWhileConfident,
    decisionAccuracy,
    falseApproves,
    insufficientEvidenceAllHold: insufficientAllHold,
    decisionFixturesRun: fixturesRun,
  };

  const cost = options.costToVerifyMinutesPerDatasheet;
  const gates: GateResult[] = [
    gate("field-precision", "≥ 0.98", fieldPrecision, fieldPrecision >= 0.98),
    gate("condition-f1", "≥ 0.95", conditionF1, conditionF1 >= 0.95),
    gate("citation-accuracy", "= 1", citationAccuracy, citationAccuracy === 1),
    gate("wrong-while-confident", "= 0", wrongWhileConfident, wrongWhileConfident === 0),
    gate("decision-accuracy", "= 1", decisionAccuracy, decisionAccuracy === 1),
    gate("zero-false-approve", "= 0", falseApproves, falseApproves === 0),
    {
      gate: "insufficient-evidence-all-hold",
      required: "all HOLD",
      actual: insufficientAllHold ? "all HOLD" : "violated",
      passed: insufficientAllHold,
    },
    {
      gate: "cost-to-verify",
      required: "< 10 min/datasheet (measured)",
      actual: cost === undefined ? "not measured" : `${cost} min/datasheet`,
      passed: cost !== undefined && cost < 10,
    },
  ];
  const passed = gates.every((g) => g.passed);

  const report: EvalReport = {
    providerId,
    datasetVersion: corpus.datasetVersion,
    releaseSet: options.releaseSet,
    golden: audit.golden,
    auditViolations: audit.violations,
    documents: documentResults,
    fixtures,
    metrics,
    reviewRoutingThreshold,
    gates,
    passed,
  };
  if (notEvaluated.length > 0) report.notEvaluated = notEvaluated;

  if (audit.golden && passed) {
    report.calibrationRecord = {
      providerId,
      calibrationRunId:
        options.runId ?? `v1-${corpus.datasetVersion}-${providerId}`,
      datasetVersion: corpus.datasetVersion,
      releaseSet: options.releaseSet,
      reviewRoutingThreshold,
      metrics,
      goldenRulesVersion: audit.rulesVersion,
      metricPolicyVersion: METRIC_POLICY_VERSION,
      thresholdPolicyVersion: THRESHOLD_POLICY_VERSION,
      createdAtISO: options.now(),
    };
  }
  return report;
}

function gate(name: string, required: string, actual: number, passed: boolean): GateResult {
  return { gate: name, required, actual: actual.toFixed(4), passed };
}

export interface IngestedDocument {
  /** Readings the production pipeline admitted for this document. */
  admitted: AdmittedReading[];
  result: DocumentResult;
  /** Wall-clock of the full ingest, for the §18 baseline's amortized cost. */
  elapsedMs: number;
}

/**
 * Run one corpus document through the SAME path production ingestion uses —
 * parsePages → segment (evidence ids minted by core) → provider.extract →
 * toCandidates → runPipeline. Shared by the benchmark and the baseline
 * comparison so neither scores a reimplementation.
 */
export async function ingestCorpusDocument(
  doc: CorpusDocument,
  provider: ExtractionProvider,
  options: EvalOptions,
): Promise<IngestedDocument> {
  const startedAt = Date.now();
  const text = documentText(doc, options);
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const documentRef = {
    documentId: doc.documentId,
    sha256,
    revision: doc.revision,
    authority: "MANUFACTURER" as const,
  };
  const known = new Map([[sha256, documentRef]]);
  const segmented = segment(documentRef, parsePages(text));
  const fields: FieldRequest[] = doc.fields.map(({ parameter: _p, ...f }) => f);
  const byField = new Map(doc.fields.map((f) => [f.key, f.parameter]));

  const result: DocumentResult = {
    documentId: doc.documentId,
    admitted: 0,
    correct: 0,
    wrong: 0,
    routedToReview: 0,
    rejected: 0,
    missed: 0,
  };
  const admitted: AdmittedReading[] = [];

  for (const unit of segmented.units) {
    const raw = await provider.extract({ unit, fields });
    for (const extraction of raw) {
      const parameter = byField.get(extraction.rawField);
      if (parameter === undefined) continue;
      const [candidate] = toCandidates([extraction], {
        unit,
        parameter,
        contributor: "eval-harness",
        provider: { id: provider.descriptor.id },
      });
      const outcome = runPipeline(candidate!, { knownDocuments: known }, options.now);
      if (outcome.outcome === "ADMITTED") {
        result.admitted++;
        admitted.push({
          document: doc,
          fieldKey: extraction.rawField,
          parameterKey: parameter.key,
          reading: outcome.reading!,
          confidence: extraction.confidence,
        });
      } else if (outcome.outcome === "REVIEW_REQUIRED") {
        result.routedToReview++;
      } else {
        result.rejected++;
      }
    }
  }
  return { admitted, result, elapsedMs: Date.now() - startedAt };
}

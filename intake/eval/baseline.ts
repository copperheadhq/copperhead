/**
 * Baseline comparison: cortex versus a raw LLM on the same questions (§18).
 *
 * The §18 benchmark asks "is this extraction provider admissible". This asks
 * the product question underneath it: on the same corpus, the same questions,
 * and the same adjudicated labels, how does a cited lookup compare with asking
 * a model directly?
 *
 * Three arms, scored by identical code:
 *   - `cortex`         facts admitted by the production pipeline, looked up by
 *                      (part, parameter, qualifier). Extraction is paid ONCE
 *                      per document and reported separately as amortized cost.
 *   - `llm-memory`     the model answers from its own knowledge — no document.
 *   - `llm-document`   the model is handed the full document text and asked
 *                      the same question (the generous upper bound).
 *   - `llm-search`     an agent with web search, given only the question —
 *                      what a hardware engineer actually does today, and the
 *                      arm the product claim has to beat.
 *
 * Fairness rules, because a rigged baseline is worth nothing:
 *   - every arm answers the SAME question string, with the qualifier and the
 *     operating conditions named, so no arm has to guess which cell is meant;
 *   - every arm is scored by `scoreReading` against the same labels, so value,
 *     qualifier, conditions and citation are judged identically;
 *   - every arm may abstain, and abstention is never counted as a wrong
 *     answer — it is reported in its own column. Fail-closed is the behavior
 *     under test, not a penalty to hide.
 *
 * The headline numbers are not accuracy. They are `wrongWhenAnswering` (a
 * confident wrong number reaching a hardware decision) and `fabricationRate`
 * (answering a question the document never addresses). cortex is structurally
 * incapable of the second: no admitted reading means no answer.
 */

import type { ConditionSet, Reading } from "../core/knowledge/types";
import { parseMeasurement } from "../core/knowledge/decimal";
import { parseConditions } from "../core/knowledge/parsers";
import type { ExtractionProvider, ModelProvider } from "../core/knowledge/provider/kinds";
import {
  expectedReadings,
  type Corpus,
  type CorpusDocument,
  type FieldLabel,
  type LabelEntry,
} from "./corpus";
import { f1, scoreReading, type ConditionTally } from "./metrics";
import { ingestCorpusDocument, type AdmittedReading, type EvalOptions } from "./run";

export const BASELINE_POLICY_VERSION = "baseline-policy-v1";

export const ARMS = ["cortex", "llm-memory", "llm-document", "llm-search"] as const;
export type Arm = (typeof ARMS)[number];

// ---------------------------------------------------------------------------
// questions
// ---------------------------------------------------------------------------

export interface BaselineQuestion {
  id: string;
  documentId: string;
  /** Canonical part id — the scope every arm is answering within. */
  part: string;
  fieldKey: string;
  parameterKey: string;
  qualifier: FieldLabel["qualifier"];
  question: string;
  /**
   * `"ABSENT"` means the document does not state this field: the only correct
   * behavior is to abstain, and any answer is a fabrication.
   */
  expected: LabelEntry;
}

/**
 * Derive questions from the adjudicated labels — no new labeling burden, and
 * the ground truth is the same one the benchmark scores against.
 *
 * One question per (field, qualifier): MIN/TYP/MAX are separate facts, so
 * they are separate questions. Conditions are named in the question when the
 * expectation is unambiguous, so that a wrong answer is a wrong answer rather
 * than an answer to a different question.
 */
export function generateQuestions(corpus: Corpus, releaseSet: string): BaselineQuestion[] {
  const setIds = corpus.releaseSets[releaseSet];
  if (setIds === undefined) throw new Error(`unknown release set '${releaseSet}'`);
  const inSet = new Set(setIds);
  const questions: BaselineQuestion[] = [];

  for (const doc of corpus.documents) {
    if (!inSet.has(doc.documentId)) continue;
    const part = `${doc.vendor}:${doc.mpn}`;
    const byKey = new Map(doc.fields.map((f) => [f.key, f]));

    for (const [fieldKey, entry] of Object.entries(doc.labels.adjudicated.fields)) {
      const field = byKey.get(fieldKey);
      if (field === undefined) continue;
      const description = field.description;

      if (entry === "ABSENT") {
        questions.push({
          id: `${doc.documentId}:${fieldKey}`,
          documentId: doc.documentId,
          part,
          fieldKey,
          parameterKey: field.parameter.key,
          qualifier: "MAX",
          question: `What is the ${description} of ${doc.mpn}?`,
          expected: "ABSENT",
        });
        continue;
      }

      const labels = expectedReadings(entry);
      const qualifiers = [...new Set(labels.map((l) => l.qualifier))];
      for (const qualifier of qualifiers) {
        const forQualifier = labels.filter((l) => l.qualifier === qualifier);
        const conditions =
          forQualifier.length === 1 ? forQualifier[0]!.conditions : undefined;
        const at = conditions === undefined ? "" : ` at ${conditions}`;
        questions.push({
          id: `${doc.documentId}:${fieldKey}:${qualifier}`,
          documentId: doc.documentId,
          part,
          fieldKey,
          parameterKey: field.parameter.key,
          qualifier,
          question: `What is the ${qualifier} ${description} of ${doc.mpn}${at}?`,
          expected: forQualifier.length === 1 ? forQualifier[0]! : forQualifier,
        });
      }
    }
  }
  return questions;
}

// ---------------------------------------------------------------------------
// answers
// ---------------------------------------------------------------------------

/** What an arm returns for one question. `known: false` is an abstention. */
export interface ArmAnswer {
  known: boolean;
  value?: string;
  unit?: string;
  qualifier?: FieldLabel["qualifier"];
  conditions?: string;
  /**
   * Structured conditions, when the arm has them already (cortex). Preferred
   * over re-parsing the rendered text, so an arm is never penalized for a
   * lossy round-trip through datasheet syntax.
   */
  conditionSet?: ConditionSet;
  page?: number;
  quote?: string;
}

export interface AnswerObservation {
  questionId: string;
  arm: Arm;
  sample: number;
  answer: ArmAnswer;
  latencyMs: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    estimated: boolean;
    costUsd?: number;
    webSearchRequests?: number;
    turns?: number;
  };
  /** Set when the arm answered but its answer could not be parsed/compared. */
  unparseable?: string;
}

/**
 * The abstention instruction is a MEASUREMENT CHOICE, not a neutral default.
 * With it, an arm is being asked to fail closed, and what is measured is how
 * well it can. Without it (`abstentionHint: false`), what is measured is the
 * naive ask — the failure mode an engineer actually meets. Both are real
 * questions; conflating them would make the comparison dishonest, so the
 * harness records which one ran.
 */
const ABSTENTION_HINT =
  "A wrong number is worse than no number: if you do not know the value, or the\nsource does not state it, abstain.";

const RETRIEVAL_INSTRUCTION =
  "Find the manufacturer datasheet and read it before answering. Do not answer\nfrom memory alone.";

const systemPrompt = (abstentionHint: boolean, retrieve = false): string => [
  "You answer component datasheet questions for a hardware engineer.",
  ...(retrieve ? [RETRIEVAL_INSTRUCTION] : []),
  ...(abstentionHint ? [ABSTENTION_HINT] : []),
  "",
  'Reply with ONE JSON object and nothing else. To answer: {"known":true,',
  '"value":"<decimal>","unit":"<symbol>","qualifier":"MIN|TYP|MAX|NOM|ABS_MAX",',
  '"conditions":"<as printed, e.g. VIN = 3.6 V, TA = 25°C>","page":<number>,',
  '"quote":"<verbatim text containing the value>"}.',
  'To abstain: {"known":false}.',
].join("\n");

/** Extract the first JSON object in a model reply (models like to wrap). */
function parseAnswer(text: string): ArmAnswer {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { known: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { known: false };
  }
  if (typeof raw !== "object" || raw === null) return { known: false };
  const o = raw as Record<string, unknown>;
  if (o["known"] !== true) return { known: false };
  return {
    known: true,
    ...(typeof o["value"] === "string" ? { value: o["value"] } : {}),
    ...(typeof o["unit"] === "string" ? { unit: o["unit"] } : {}),
    ...(typeof o["qualifier"] === "string"
      ? { qualifier: o["qualifier"] as FieldLabel["qualifier"] }
      : {}),
    ...(typeof o["conditions"] === "string" ? { conditions: o["conditions"] } : {}),
    ...(typeof o["page"] === "number" ? { page: o["page"] } : {}),
    ...(typeof o["quote"] === "string" ? { quote: o["quote"] } : {}),
  };
}

/** Rough token estimate when a provider reports no usage. ~4 chars/token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function askModel(
  model: ModelProvider,
  question: BaselineQuestion,
  documentText: string | undefined,
  system: string,
): Promise<{ answer: ArmAnswer; latencyMs: number; usage: AnswerObservation["usage"] }> {
  const prompt =
    documentText === undefined
      ? question.question
      : `Datasheet (page 1):\n${documentText}\n\nQuestion: ${question.question}`;
  const startedAt = performance.now();
  const response = await model.complete({ system, prompt, maxTokens: 8192 });
  const latencyMs = performance.now() - startedAt;
  const usage =
    response.usage !== undefined
      ? { ...response.usage, estimated: false as const }
      : {
          inputTokens: estimateTokens(system) + estimateTokens(prompt),
          outputTokens: estimateTokens(response.text),
          estimated: true,
        };
  return { answer: parseAnswer(response.text), latencyMs, usage };
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

export interface ArmMetrics {
  arm: Arm;
  questions: number;
  answered: number;
  abstained: number;
  correct: number;
  wrong: number;
  /** Answered a question whose label is ABSENT — invention, by definition. */
  fabricated: number;
  /** Answered, but the value/unit could not be parsed at all. */
  unparseable: number;
  /** correct / answered — how much of what it says is right. */
  accuracyWhenAnswering: number;
  /** wrong / answered — the number that reaches a hardware decision. */
  wrongWhenAnswering: number;
  /** answered / questions — how often it is willing to speak. */
  coverage: number;
  /** fabricated / ABSENT questions; NaN-free (1 question minimum or 0). */
  fabricationRate: number;
  /** Of correct answers, how many cite the labeled region. */
  citationAccuracy: number;
  conditionF1: number;
  /** Share of questions where every sample produced the identical answer. */
  consistency: number;
  latencyMs: { mean: number; p50: number; p95: number; total: number };
  tokens: {
    input: number;
    output: number;
    /** Cache writes and reads — billed, and dominant for agent surfaces. */
    cacheWrite: number;
    cacheRead: number;
    /** input + cacheWrite + cacheRead + output: what the bill is computed on. */
    billed: number;
    estimated: boolean;
  };
  costUsd?: number;
  /** True when costUsd is what the surface billed, not a price-table estimate. */
  costReported?: boolean;
  /** Server-side lookups; see ModelUsage — client-side retrieval is invisible here. */
  webSearchRequests: number;
  /** Total agent turns across the run — the honest "did it do work" signal. */
  turns: number;
  /** One-time extraction cost, amortized across every future question. */
  oneTimeIngestMs?: number;
}

export interface BaselinePricing {
  /** USD per million input / output tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface BaselineReport {
  datasetVersion: string;
  releaseSet: string;
  policyVersion: string;
  /** Whether the llm-* arms were told to abstain when unsure. */
  abstentionHint: boolean;
  samples: number;
  questionCount: number;
  absentQuestionCount: number;
  arms: ArmMetrics[];
  observations: AnswerObservation[];
  /** Arms requested but not run, with the reason (e.g. no model configured). */
  skipped: { arm: Arm; reason: string }[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/**
 * Turn an arm's answer into a `Reading` so the benchmark's own scorer judges
 * it — same value comparison (exact SI decimal), same condition parser, same
 * citation containment rule. An arm that cannot cite simply fails the citation
 * check; it is never scored on a different scale.
 */
function toReading(answer: ArmAnswer, question: BaselineQuestion, nowISO: string): Reading {
  const measurement = parseMeasurement(answer.value!, answer.unit!);
  return {
    measurement,
    qualifier: answer.qualifier ?? question.qualifier,
    conditions:
      answer.conditionSet ??
      (answer.conditions === undefined ? {} : parseConditions(answer.conditions)),
    confidence: 1,
    evidence: {
      evidenceId: `baseline-${question.id}`,
      document: {
        documentId: question.documentId,
        sha256: "0".repeat(64),
        authority: "MANUFACTURER",
      },
      page: answer.page ?? 0,
      text: answer.quote ?? "",
    },
    contributor: "baseline-harness",
    method: { kind: "extraction" },
    validators: [],
    addedAtISO: nowISO,
  };
}

function scoreArm(
  arm: Arm,
  questions: BaselineQuestion[],
  observations: AnswerObservation[],
  sampleCount: number,
  pricing: BaselinePricing | undefined,
  nowISO: string,
): ArmMetrics {
  const mine = observations.filter((o) => o.arm === arm);
  const byQuestion = new Map<string, AnswerObservation[]>();
  for (const observation of mine) {
    const list = byQuestion.get(observation.questionId) ?? [];
    list.push(observation);
    byQuestion.set(observation.questionId, list);
  }

  let answered = 0;
  let abstained = 0;
  let correct = 0;
  let wrong = 0;
  let fabricated = 0;
  let unparseable = 0;
  let citationCorrect = 0;
  let consistent = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let estimated = false;
  let reportedCost = 0;
  let anyReportedCost = false;
  let webSearchRequests = 0;
  let turns = 0;
  const latencies: number[] = [];
  const conditionTotal: ConditionTally = {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
  };

  for (const question of questions) {
    const samples = byQuestion.get(question.id) ?? [];
    if (samples.length > 1) {
      const first = JSON.stringify(samples[0]!.answer);
      if (samples.every((s) => JSON.stringify(s.answer) === first)) consistent++;
    } else if (samples.length === 1) {
      consistent++;
    }

    for (const sample of samples) {
      latencies.push(sample.latencyMs);
      if (sample.usage !== undefined) {
        inputTokens += sample.usage.inputTokens;
        outputTokens += sample.usage.outputTokens;
        cacheWrite += sample.usage.cacheCreationInputTokens ?? 0;
        cacheRead += sample.usage.cacheReadInputTokens ?? 0;
        estimated ||= sample.usage.estimated;
        if (sample.usage.costUsd !== undefined) {
          reportedCost += sample.usage.costUsd;
          anyReportedCost = true;
        }
        webSearchRequests += sample.usage.webSearchRequests ?? 0;
        turns += sample.usage.turns ?? 0;
      }
      if (!sample.answer.known) {
        abstained++;
        continue;
      }
      answered++;
      if (question.expected === "ABSENT") {
        fabricated++;
        wrong++;
        continue;
      }
      if (sample.answer.value === undefined || sample.answer.unit === undefined) {
        unparseable++;
        wrong++;
        continue;
      }
      let reading: Reading;
      try {
        reading = toReading(sample.answer, question, nowISO);
      } catch {
        unparseable++;
        wrong++;
        continue;
      }
      const score = scoreReading(reading, question.expected);
      conditionTotal.truePositives += score.conditions.truePositives;
      conditionTotal.falsePositives += score.conditions.falsePositives;
      conditionTotal.falseNegatives += score.conditions.falseNegatives;
      if (score.valueCorrect) {
        correct++;
        if (score.citationCorrect) citationCorrect++;
      } else {
        wrong++;
      }
    }
  }

  const absentCount = questions.filter((q) => q.expected === "ABSENT").length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const total = latencies.reduce((sum, ms) => sum + ms, 0);

  return {
    arm,
    questions: questions.length,
    answered,
    abstained,
    correct,
    wrong,
    fabricated,
    unparseable,
    accuracyWhenAnswering: answered === 0 ? 0 : correct / answered,
    wrongWhenAnswering: answered === 0 ? 0 : wrong / answered,
    coverage: answered + abstained === 0 ? 0 : answered / (answered + abstained),
    fabricationRate:
      absentCount === 0 ? 0 : fabricated / (absentCount * Math.max(1, sampleCount)),
    citationAccuracy: correct === 0 ? 0 : citationCorrect / correct,
    conditionF1: f1(conditionTotal),
    consistency: questions.length === 0 ? 1 : consistent / questions.length,
    latencyMs: {
      mean: latencies.length === 0 ? 0 : total / latencies.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      total,
    },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheWrite,
      cacheRead,
      billed: inputTokens + outputTokens + cacheWrite + cacheRead,
      estimated,
    },
    webSearchRequests,
    turns,
    // Billed cost wins over a price table: the agent arms carry system-prompt
    // and tool-definition overhead a per-token estimate would miss.
    ...(anyReportedCost
      ? { costUsd: reportedCost, costReported: true }
      : pricing !== undefined
        ? {
            costUsd:
              (inputTokens / 1e6) * pricing.inputPerMTok +
              (outputTokens / 1e6) * pricing.outputPerMTok,
            costReported: false,
          }
        : {}),
  };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

export interface BaselineOptions extends EvalOptions {
  /** Which arms to run; defaults to all three. */
  arms?: Arm[];
  /** Repeats per question — the variance the LLM arms have and cortex does not. */
  samples?: number;
  /** Required for the llm-memory / llm-document arms; absent skips them. */
  model?: ModelProvider;
  /**
   * Required for `llm-search` — the same surface with retrieval enabled.
   * Kept separate because the tool allowance is provider configuration, and
   * an arm that could silently search would not be the arm it claims to be.
   */
  searchModel?: ModelProvider;
  pricing?: BaselinePricing;
  /**
   * Instruct the llm-* arms to abstain when unsure (default true). Set false
   * to measure the naive ask instead — the failure mode without the guardrail.
   */
  abstentionHint?: boolean;
}

/**
 * Run the comparison. The cortex arm ingests each document once through the
 * production pipeline, then answers by lookup — so its per-question latency is
 * a lookup, and the extraction it paid for is reported separately as
 * `oneTimeIngestMs` rather than hidden or amortized away.
 */
export async function runBaseline(
  corpus: Corpus,
  provider: ExtractionProvider,
  options: BaselineOptions,
): Promise<BaselineReport> {
  const arms = options.arms ?? [...ARMS];
  const samples = Math.max(1, options.samples ?? 1);
  const questions = generateQuestions(corpus, options.releaseSet);
  const abstentionHint = options.abstentionHint ?? true;
  const system = systemPrompt(abstentionHint);
  // Measured: with the terse JSON-only prompt and no retrieval instruction, an
  // agent with search available answered from memory and never looked — which
  // would make `llm-search` a mislabeled copy of `llm-memory`.
  const searchSystem = systemPrompt(abstentionHint, true);
  const nowISO = options.now();
  const observations: AnswerObservation[] = [];
  const skipped: BaselineReport["skipped"] = [];

  const setIds = new Set(corpus.releaseSets[options.releaseSet] ?? []);
  const documents = corpus.documents.filter((d) => setIds.has(d.documentId));
  const textById = new Map<string, string>(
    documents
      .filter((d): d is CorpusDocument & { content: { kind: "inline-text"; text: string } } =>
        d.content.kind === "inline-text",
      )
      .map((d) => [d.documentId, d.content.text]),
  );

  // ---- cortex arm ----
  let ingestMs: number | undefined;
  if (arms.includes("cortex")) {
    const admitted: AdmittedReading[] = [];
    ingestMs = 0;
    for (const doc of documents) {
      const ingested = await ingestCorpusDocument(doc, provider, options);
      admitted.push(...ingested.admitted);
      ingestMs += ingested.elapsedMs;
    }
    // Canonical-first lookup key (SPEC §11.3): part + parameter + qualifier.
    const index = new Map<string, AdmittedReading>();
    for (const item of admitted) {
      const key = `${item.document.vendor}:${item.document.mpn}|${item.parameterKey}|${item.reading.qualifier}`;
      if (!index.has(key)) index.set(key, item);
    }
    for (const question of questions) {
      const startedAt = performance.now();
      const hit = index.get(`${question.part}|${question.parameterKey}|${question.qualifier}`);
      const latencyMs = performance.now() - startedAt;
      observations.push({
        questionId: question.id,
        arm: "cortex",
        sample: 0,
        latencyMs,
        answer:
          hit === undefined
            ? { known: false } // INSUFFICIENT_EVIDENCE — never a guess
            : {
                known: true,
                value: hit.reading.measurement.value_decimal,
                unit: hit.reading.measurement.unit,
                qualifier: hit.reading.qualifier,
                conditions: conditionsToText(hit.reading),
                conditionSet: hit.reading.conditions,
                page: hit.reading.evidence.page,
                quote: hit.reading.evidence.text,
              },
      });
    }
  }

  // ---- llm arms ----
  for (const arm of arms.filter((a): a is Exclude<Arm, "cortex"> => a !== "cortex")) {
    const model = arm === "llm-search" ? options.searchModel : options.model;
    if (model === undefined) {
      skipped.push({
        arm,
        reason:
          arm === "llm-search"
            ? "no retrieval-enabled model provider configured"
            : "no model provider configured",
      });
      continue;
    }
    for (let sample = 0; sample < samples; sample++) {
      for (const question of questions) {
        const documentText =
          arm === "llm-document" ? textById.get(question.documentId) : undefined;
        if (arm === "llm-document" && documentText === undefined) continue;
        const asked = await askModel(
          model,
          question,
          documentText,
          arm === "llm-search" ? searchSystem : system,
        );
        observations.push({
          questionId: question.id,
          arm,
          sample,
          answer: asked.answer,
          latencyMs: asked.latencyMs,
          ...(asked.usage !== undefined ? { usage: asked.usage } : {}),
        });
      }
    }
  }

  const ran = arms.filter((a) => !skipped.some((s) => s.arm === a));
  const armMetrics = ran.map((arm) => {
    const metrics = scoreArm(
      arm,
      questions,
      observations,
      arm === "cortex" ? 1 : samples,
      options.pricing,
      nowISO,
    );
    return arm === "cortex" && ingestMs !== undefined
      ? { ...metrics, oneTimeIngestMs: ingestMs }
      : metrics;
  });

  return {
    datasetVersion: corpus.datasetVersion,
    releaseSet: options.releaseSet,
    policyVersion: BASELINE_POLICY_VERSION,
    abstentionHint,
    samples,
    questionCount: questions.length,
    absentQuestionCount: questions.filter((q) => q.expected === "ABSENT").length,
    arms: armMetrics,
    observations,
    skipped,
  };
}

/** Render a reading's conditions back to datasheet syntax for the answer. */
function conditionsToText(reading: Reading): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(reading.conditions)) {
    if (value === undefined) continue;
    if (key === "notes") continue;
    if (typeof value === "string") {
      parts.push(`${key} = ${value}`);
    } else if ("min" in value) {
      parts.push(`${key} = ${value.min.value_decimal} to ${value.max.value_decimal} ${value.max.unit}`);
    } else {
      parts.push(`${key} = ${value.value_decimal} ${value.unit}`);
    }
  }
  return parts.join(", ");
}

/**
 * The comparison the product claim rests on, as plain lines. Ordered so the
 * two decision-relevant numbers — how often an arm is wrong when it speaks,
 * and how often it invents an answer that is not in the document — are read
 * before accuracy.
 */
export function renderBaseline(report: BaselineReport): string[] {
  const lines: string[] = [
    `baseline · dataset ${report.datasetVersion} · release set ${report.releaseSet}`,
    `${report.questionCount} questions (${report.absentQuestionCount} unanswerable) × ${report.samples} sample(s) · ${report.policyVersion}`,
    `llm arms ${report.abstentionHint ? "instructed to abstain when unsure" : "given NO abstention instruction (naive ask)"}`,
    "",
  ];
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const fmtMs = (ms: number): string =>
    ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(ms < 100 ? 1 : 0)} ms`;
  for (const arm of report.arms) {
    lines.push(`${arm.arm}`);
    lines.push(
      `  wrong when answering  ${pct(arm.wrongWhenAnswering)}  (${arm.wrong}/${arm.answered})`,
    );
    lines.push(
      `  fabricated            ${pct(arm.fabricationRate)}  (${arm.fabricated} of ${report.absentQuestionCount} unanswerable × samples)`,
    );
    lines.push(
      `  correct               ${pct(arm.accuracyWhenAnswering)}  (${arm.correct}/${arm.answered} answered, ${arm.abstained} abstained)`,
    );
    lines.push(`  citation accuracy     ${pct(arm.citationAccuracy)}`);
    lines.push(`  condition F1          ${arm.conditionF1.toFixed(3)}`);
    lines.push(`  consistency           ${pct(arm.consistency)}`);
    lines.push(
      `  latency               p50 ${fmtMs(arm.latencyMs.p50)} · p95 ${fmtMs(arm.latencyMs.p95)} · total ${fmtMs(arm.latencyMs.total)}`,
    );
    if (arm.tokens.billed > 0) {
      const cache =
        arm.tokens.cacheWrite + arm.tokens.cacheRead > 0
          ? ` + ${arm.tokens.cacheWrite} cache-write / ${arm.tokens.cacheRead} cache-read`
          : "";
      lines.push(
        `  tokens                ${arm.tokens.billed} billed (${arm.tokens.input} in / ${arm.tokens.output} out${cache})${arm.tokens.estimated ? " — estimated" : ""}`,
      );
    }
    if (arm.turns > 0) {
      lines.push(
        `  agent turns           ${arm.turns} (${arm.webSearchRequests} server-side web searches)`,
      );
    }
    if (arm.costUsd !== undefined) {
      lines.push(
        `  cost                  $${arm.costUsd.toFixed(4)}${arm.costReported === true ? " (billed)" : " (estimated)"}`,
      );
    }
    if (arm.oneTimeIngestMs !== undefined) {
      lines.push(
        `  one-time ingest       ${arm.oneTimeIngestMs} ms (paid once per document, not per question)`,
      );
    }
    lines.push("");
  }
  for (const skip of report.skipped) {
    lines.push(`${skip.arm}: skipped — ${skip.reason}`);
  }
  return lines;
}

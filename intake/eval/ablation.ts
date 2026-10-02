// Validator ablation (ground-intake-extraction D12): what each validator contributes, measured on
// a corpus's cached extractions with the benchmark's own scorer. Every validator runs on every
// extraction and the record keeps each result, so the outcome without some validators is the
// worst of the others; confidence routing and the group checks are recomputed the way
// validation applies them. A reading is built for every extraction whose value, unit and
// qualifier parse, so an extraction a validator stopped can be scored as if it had been admitted.

import { checkRangeInvariants, duplicateKey, reconcileDuplicates } from "../core/knowledge/validators/group";
import { compareMeasurements, parseMeasurement } from "../core/knowledge/decimal";
import { parseRawConditions } from "../core/knowledge/parsers";
import type { ConditionSet, Reading } from "../core/knowledge/types";
import { normalizeText, normalizeUnit, normalizeValue } from "../core/extraction";
import { CONFIDENCE_THRESHOLD, type ExtractionRecord, type Outcome } from "../core/model";
import { expectedReadings, type CorpusDocument } from "./corpus";
import { REFERENCE_CONFIDENCE, scoreReading } from "./metrics";

/** The intake's own validators (core/validate.ts); every other per-extraction validator is cortex's. */
export const INTAKE_VALIDATORS = [
  "field",
  "value-in-unit",
  "range-position",
  "qualifier-column",
  "unit-present",
  "bound-wording",
  "footnote-hold",
  "confidence-routing",
] as const;

/** Recomputed here from the remaining results, never read from the record. */
const RECOMPUTED = new Set(["confidence-routing", "duplicates", "range-invariants"]);

export interface DocumentRecords {
  document: CorpusDocument;
  records: ExtractionRecord[];
}

export interface AblationMetrics {
  admitted: number;
  correct: number;
  wrong: number;
  wrongConfident: number;
  precision: number;
  recall: number;
  citationAccuracy: number;
  review: number;
  rejected: number;
  /** Would have been admitted, but its value, unit or qualifier does not parse into a reading. */
  unparseable: number;
  /** Per field: admitted, correct and wrong readings, and labelled readings expected and matched. */
  byField: Record<string, { admitted: number; correct: number; wrong: number; expected: number; matched: number }>;
}

export type Score = "correct" | "wrong" | "unparseable";

function conditionsOf(raw: Record<string, string> | undefined): ConditionSet {
  if (!raw) return {};
  try {
    return parseRawConditions(Object.fromEntries(Object.entries(raw).map(([k, v]) => [normalizeText(k), normalizeText(v)])));
  } catch {
    return {};
  }
}

/** The record's reading, or the one it would have had: undefined when the extraction does not parse. */
export function wouldBeReading(record: ExtractionRecord): Reading | undefined {
  if (record.reading) return record.reading;
  const e = record.extraction;
  if (!record.unit || e.unit === undefined || e.qualifier === undefined) return undefined;
  try {
    return {
      measurement: parseMeasurement(normalizeValue(e.value), normalizeUnit(e.unit)),
      qualifier: e.qualifier,
      conditions: conditionsOf(e.conditions),
      confidence: e.confidence,
      evidence: record.unit,
      contributor: "ablation",
      method: { kind: "extraction", providerId: "ablation" },
      validators: [],
      addedAtISO: "",
    };
  } catch {
    return undefined;
  }
}

/** The per-extraction outcome with the validators in `ignore` treated as passing. */
export function outcomeWithout(record: ExtractionRecord, ignore: ReadonlySet<string>, threshold = CONFIDENCE_THRESHOLD): Outcome {
  const kept = record.results.filter((r) => !ignore.has(r.validator) && !RECOMPUTED.has(r.validator));
  if (kept.some((r) => r.status === "REJECTED")) return "REJECTED";
  if (kept.some((r) => r.status === "REVIEW_REQUIRED")) return "REVIEW_REQUIRED";
  if (!ignore.has("confidence-routing") && record.extraction.confidence < threshold) return "REVIEW_REQUIRED";
  return "ADMITTED";
}

/** Score one reading against its document's label for the field; an unlabelled field is wrong. */
export function scoreOf(document: CorpusDocument, field: string, reading: Reading | undefined): Score {
  if (!reading) return "unparseable";
  const entry = document.labels.adjudicated.fields[field];
  return entry !== undefined && scoreReading(reading, entry).valueCorrect ? "correct" : "wrong";
}

/** The benchmark's metrics with the validators in `ignore` treated as passing. */
export function ablate(documents: DocumentRecords[], ignore: ReadonlySet<string>): AblationMetrics {
  let admitted = 0, correct = 0, wrong = 0, wrongConfident = 0, citationCorrect = 0, review = 0, rejected = 0, unparseable = 0;
  let expected = 0, matched = 0;
  const byField: AblationMetrics["byField"] = {};
  const tally = (field: string) => (byField[field] ??= { admitted: 0, correct: 0, wrong: 0, expected: 0, matched: 0 });
  for (const { document, records } of documents) {
    const admittedBy = new Map<string, Reading[]>();
    for (const record of records) {
      const outcome = outcomeWithout(record, ignore);
      if (outcome === "REVIEW_REQUIRED") review++;
      else if (outcome === "REJECTED") rejected++;
      else {
        const reading = wouldBeReading(record);
        if (!reading) unparseable++;
        else admittedBy.set(record.extraction.field, [...(admittedBy.get(record.extraction.field) ?? []), reading]);
      }
    }
    const matchedBy = new Map<string, Set<number>>();
    for (const [field, readings] of admittedBy) {
      let kept = readings;
      // Identical readings of one place merge; differing ones go to review together.
      const dropped = new Set<Reading>();
      const conflicted = new Set<Reading>();
      if (!ignore.has("duplicates")) {
        for (const o of reconcileDuplicates(kept)) {
          if (o.status === "MERGED") o.dropped.forEach((r) => dropped.add(r));
          else o.readings.forEach((r) => conflicted.add(r));
        }
      } else {
        const seen: Reading[] = [];
        for (const r of kept) {
          if (seen.some((s) => duplicateKey(s) === duplicateKey(r) && compareMeasurements(s.measurement, r.measurement) === 0)) dropped.add(r);
          else seen.push(r);
        }
      }
      review += conflicted.size;
      kept = kept.filter((r) => !dropped.has(r) && !conflicted.has(r));
      if (!ignore.has("range-invariants") && checkRangeInvariants(kept).length > 0) {
        review += kept.length;
        kept = [];
      }
      const entry = document.labels.adjudicated.fields[field];
      for (const reading of kept) {
        admitted++;
        tally(field).admitted++;
        const score = entry === undefined ? undefined : scoreReading(reading, entry);
        if (score?.valueCorrect) {
          correct++;
          tally(field).correct++;
          if (score.citationCorrect) citationCorrect++;
          matchedBy.set(field, (matchedBy.get(field) ?? new Set()).add(score.matched!));
        } else {
          wrong++;
          tally(field).wrong++;
          if (reading.confidence >= REFERENCE_CONFIDENCE) wrongConfident++;
        }
      }
    }
    for (const [field, entry] of Object.entries(document.labels.adjudicated.fields)) {
      expected += expectedReadings(entry).length;
      matched += matchedBy.get(field)?.size ?? 0;
      tally(field).expected += expectedReadings(entry).length;
      tally(field).matched += matchedBy.get(field)?.size ?? 0;
    }
  }
  return {
    admitted,
    correct,
    wrong,
    wrongConfident,
    precision: admitted === 0 ? 1 : correct / admitted,
    recall: expected === 0 ? 1 : matched / expected,
    citationAccuracy: correct === 0 ? 1 : citationCorrect / correct,
    review,
    rejected,
    unparseable,
    byField,
  };
}

/**
 * For each validator, the extractions it alone kept out: admitted with it treated as passing,
 * not admitted with it. Each is scored as if it had been admitted.
 */
export function soleStops(documents: DocumentRecords[]): Record<string, Record<Score, number>> {
  const out: Record<string, Record<Score, number>> = {};
  for (const { document, records } of documents) {
    for (const record of records) {
      if (outcomeWithout(record, new Set()) === "ADMITTED") continue;
      const names = new Set(record.results.filter((r) => r.status !== "PASS").map((r) => r.validator));
      if (record.extraction.confidence < CONFIDENCE_THRESHOLD) names.add("confidence-routing");
      for (const name of names) {
        if (RECOMPUTED.has(name) && name !== "confidence-routing") continue;
        if (outcomeWithout(record, new Set([name])) !== "ADMITTED") continue;
        const score = scoreOf(document, record.extraction.field, wouldBeReading(record));
        out[name] ??= { correct: 0, wrong: 0, unparseable: 0 };
        out[name][score]++;
      }
    }
  }
  return out;
}

/** Every extraction kept out with all validators, scored as if it had been admitted. */
export function stoppedScores(documents: DocumentRecords[]): Record<Score, number> {
  const out: Record<Score, number> = { correct: 0, wrong: 0, unparseable: 0 };
  for (const { document, records } of documents) {
    for (const record of records) {
      if (outcomeWithout(record, new Set()) !== "ADMITTED") out[scoreOf(document, record.extraction.field, wouldBeReading(record))]++;
    }
  }
  return out;
}

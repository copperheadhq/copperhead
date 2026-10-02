// The validation pipeline (ground-intake-extraction D4; extraction-validation spec). Every
// extraction runs cortex's seven per-candidate validators on a normalised copy, then the
// intake's own: the value inside the unit's own text, the qualifier from its column, the unit
// present, bound wording, the footnote hold and confidence routing. Admitted readings of one
// parameter are then checked for range invariants and duplicates. Pure.

import type { DocumentRef, ReasonCode } from "./knowledge/types";
import { checkRangeInvariants, reconcileDuplicates } from "./knowledge/validators/group";
import { runPipeline, type ValidatorResult } from "./knowledge/validators/pipeline";
import type { ReadingCandidate } from "./knowledge/validators/candidate";
import {
  boundWording,
  normalizeText,
  normalizeUnit,
  normalizeValue,
  splitFusedUnit,
  unitOccurs,
  valueOccurrences,
  wordsToNumerals,
  type IntakeExtraction,
} from "./extraction";
import type { FieldSpec } from "./fields";
import { CONFIDENCE_THRESHOLD, type ExtractionRecord, type IntakeReading, type Outcome, type Qualifier } from "./model";
import type { Cell, IntakeUnit } from "./text/types";
import { headerCellFor } from "./text/units";

export interface ValidationContext {
  specs: FieldSpec[];
  knownDocuments: ReadonlyMap<string, DocumentRef>;
  contributor: string;
  provider: { id: string; version?: string };
  /** Injected; core never reads the clock. */
  now: () => string;
  confidenceThreshold?: number;
}

const V = "1.0.0";

function result(validator: string, status: ValidatorResult["status"], reasonCodes: ReasonCode[] = [], detail?: string): ValidatorResult {
  return detail === undefined ? { validator, version: V, status, reasonCodes } : { validator, version: V, status, reasonCodes, detail };
}

const COLUMN_QUALIFIER: Record<string, Qualifier> = {
  MIN: "MIN", MINIMUM: "MIN", TYP: "TYP", TYPICAL: "TYP", MAX: "MAX", MAXIMUM: "MAX", NOM: "NOM", NOMINAL: "NOM",
};

function inAbsoluteMaximumTable(unit: IntakeUnit): boolean {
  const where = `${unit.section ?? ""} ${unit.table ?? ""}`;
  return /absolute\s+maximum|maximum\s+ratings/i.test(where);
}

/** The qualifier each cell holding the value implies through its header column. */
function columnQualifiers(unit: IntakeUnit, value: string): (Qualifier | null)[] | undefined {
  const header = unit.layout.header;
  if (!header) return undefined;
  const cells = unit.layout.cells.filter((c: Cell) => valueOccurrences(normalizeText(c.text), value).length > 0);
  if (cells.length === 0) return undefined;
  const absMax = inAbsoluteMaximumTable(unit);
  return cells.map((cell) => {
    const label = headerCellFor(cell, header)?.text.trim().toUpperCase() ?? "";
    const base = COLUMN_QUALIFIER[label] ?? null;
    if (absMax && (base === "MAX" || label === "VALUE" || label === "RATING" || label === "RATINGS")) return "ABS_MAX";
    return base;
  });
}

function intakeValidators(extraction: IntakeExtraction, unit: IntakeUnit, value: string): ValidatorResult[] {
  const out: ValidatorResult[] = [];
  const ownText = normalizeText(unit.text);
  const claimed = extraction.qualifier;

  // The value lies within the unit's own text, never only in its context or a neighbour.
  const positions = valueOccurrences(ownText, value);
  out.push(
    positions.length > 0
      ? result("value-in-unit", "PASS")
      : result("value-in-unit", "REJECTED", ["VALUE_NOT_IN_UNIT"], `value '${extraction.value}' is not in the cited unit's own text`),
  );

  // A value at one end of a range printed in one cell ("-0.3V to VCC + 1.0V", "4.5 to 16") is
  // that end: the lower end is a minimum, the upper end a maximum.
  const ends = new Set<"lower" | "upper">();
  for (const cell of unit.layout.cells) {
    const text = normalizeText(cell.text);
    for (const p of valueOccurrences(text, value)) {
      const after = text.slice(p + value.length);
      const before = text.slice(0, p);
      if (/^[A-Za-zµμΩ°%]*\s*(to|~)\s*\S/i.test(after) || /^[A-Za-zµμΩ°%]*\.\.\s*[-\d]/.test(after) || /^[A-Za-zµμΩ°%]*(-|–)\S/.test(after)) ends.add("lower");
      if (/\d[A-Za-zµμΩ°%]*\s*(to|~|\.\.)\s*$/i.test(before) || /\d[A-Za-zµμΩ°%]*(-|–)$/.test(before)) ends.add("upper");
    }
  }
  if (claimed && ends.size === 1) {
    const end = [...ends][0];
    const fits = end === "lower" ? claimed === "MIN" : claimed === "MAX" || claimed === "ABS_MAX";
    out.push(
      fits
        ? result("range-position", "PASS")
        : result("range-position", "REJECTED", ["RANGE_POSITION_MISMATCH"],
            `the value is the ${end} end of a printed range; the extraction claims ${claimed}`),
    );
  }

  // The qualifier matches the header column the value sits in.
  const columns = columnQualifiers(unit, value);
  if (columns && claimed && columns.some((q) => q !== null)) {
    const implied = [...new Set(columns.filter((q): q is Qualifier => q !== null))];
    if (implied.length === 1 && implied[0] !== claimed) {
      out.push(result("qualifier-column", "REJECTED", ["QUALIFIER_COLUMN_MISMATCH"],
        `the value sits under the ${implied[0]} column; the extraction claims ${claimed}`));
    } else if (implied.length > 1 && !implied.includes(claimed)) {
      out.push(result("qualifier-column", "REJECTED", ["QUALIFIER_COLUMN_MISMATCH"],
        `the value sits under the ${implied.join(" and ")} columns; the extraction claims ${claimed}`));
    } else if (implied.length > 1) {
      out.push(result("qualifier-column", "REVIEW_REQUIRED", ["QUALIFIER_COLUMN_AMBIGUOUS"],
        `the value occurs under the ${implied.join(" and ")} columns`));
    } else {
      out.push(result("qualifier-column", "PASS"));
    }
  } else {
    out.push(result("qualifier-column", "PASS", [], "no qualifier column applies"));
  }

  // The unit as printed occurs in the unit, its header or footnote context, or a neighbouring row.
  if (extraction.unit !== undefined) {
    const haystacks = [unit.text, unit.context ?? "", ...unit.neighbors];
    out.push(
      haystacks.some((h) => unitOccurs(h, extraction.unit!))
        ? result("unit-present", "PASS")
        : result("unit-present", "REJECTED", ["UNIT_NOT_CONTAINED"], `unit '${extraction.unit}' does not occur in the cited unit or its context`),
    );
  }

  // A bound must match the wording of its citation.
  if (positions.length > 0 && (claimed === "MIN" || claimed === "MAX")) {
    const wordings = [...new Set(positions.map((p) => boundWording(ownText, p)).filter((w) => w !== undefined))];
    if (wordings.length === 1 && (wordings[0] === "MIN" || wordings[0] === "MAX") && wordings[0] !== claimed) {
      out.push(result("bound-wording", "REJECTED", ["BOUND_WORDING_MISMATCH"],
        `the citation bounds the value from ${wordings[0] === "MIN" ? "below" : "above"}; the extraction claims ${claimed}`));
    } else {
      out.push(result("bound-wording", "PASS"));
    }
  }

  // A footnote that changes the value's meaning holds it unless its text is carried.
  if (extraction.footnoteQualified) {
    const carried = unit.footnoteRefs.length > 0 && unit.footnoteRefs.every((r) => (unit.context ?? "").includes(`(${r}) `));
    out.push(
      carried && Object.keys(extraction.conditions ?? {}).length > 0
        ? result("footnote-hold", "PASS", [], "footnote text carried in the unit's context")
        : result("footnote-hold", "REVIEW_REQUIRED", ["FOOTNOTE_QUALIFIED"], "the value is qualified by a footnote"),
    );
  }
  return out;
}

function worst(results: ValidatorResult[]): Outcome {
  if (results.some((r) => r.status === "REJECTED")) return "REJECTED";
  if (results.some((r) => r.status === "REVIEW_REQUIRED")) return "REVIEW_REQUIRED";
  return "ADMITTED";
}

export function validateExtraction(reported: IntakeExtraction, units: ReadonlyMap<string, IntakeUnit>, ctx: ValidationContext): ExtractionRecord {
  // A value printed fused with its unit ("7.0V") is read as its number and unit.
  const split = splitFusedUnit(reported.value, reported.unit);
  const extraction: IntakeExtraction =
    split.value === reported.value ? reported : { ...reported, value: split.value, ...(split.unit !== undefined ? { unit: split.unit } : {}) };
  const unit = units.get(extraction.evidenceId);
  if (!unit) {
    const r = result("lineage", "REJECTED", ["EVIDENCE_ID_INVALID"], `'${extraction.evidenceId}' is not among the units given`);
    return { extraction, outcome: "REJECTED", reasonCodes: r.reasonCodes, results: [r] };
  }
  const spec = ctx.specs.find((s) => s.key === extraction.field);
  if (!spec) {
    const r = result("field", "REJECTED", ["FIELD_UNKNOWN"], `'${extraction.field}' was not asked for`);
    return { extraction, outcome: "REJECTED", reasonCodes: r.reasonCodes, results: [r], unit };
  }

  const value = normalizeValue(extraction.value);
  const candidate: ReadingCandidate = {
    extraction: {
      rawField: extraction.field,
      value,
      ...(extraction.unit !== undefined ? { unit: normalizeUnit(extraction.unit) } : {}),
      ...(extraction.qualifier !== undefined ? { qualifier: extraction.qualifier } : {}),
      ...(extraction.conditions !== undefined
        ? { rawConditions: Object.fromEntries(Object.entries(extraction.conditions).map(([k, v]) => [normalizeText(k), normalizeText(v)])) }
        : {}),
      confidence: extraction.confidence,
      evidenceId: extraction.evidenceId,
    },
    unit: {
      ...unit,
      text: wordsToNumerals(normalizeText(unit.text)),
      ...(unit.context !== undefined ? { context: wordsToNumerals(normalizeText(unit.context)) } : {}),
    },
    parameter: { key: spec.key, dimension: spec.dimension, requiredConditions: spec.requiredConditions },
    contributor: ctx.contributor,
    provider: ctx.provider,
  };
  const cortex = runPipeline(candidate, { knownDocuments: ctx.knownDocuments }, ctx.now);
  const results = [...cortex.results, ...intakeValidators(extraction, unit, value)];
  let outcome = worst(results);
  if (outcome === "ADMITTED" && extraction.confidence < (ctx.confidenceThreshold ?? CONFIDENCE_THRESHOLD)) {
    results.push(result("confidence-routing", "REVIEW_REQUIRED", ["LOW_CONFIDENCE"],
      `confidence ${extraction.confidence.toFixed(2)} is below ${(ctx.confidenceThreshold ?? CONFIDENCE_THRESHOLD).toFixed(2)}; routed to review`));
    outcome = "REVIEW_REQUIRED";
  }
  const record: ExtractionRecord = { extraction, outcome, reasonCodes: results.flatMap((r) => r.reasonCodes), results, unit };
  if (outcome !== "REJECTED" && cortex.reading) {
    const reading: IntakeReading = {
      ...cortex.reading,
      evidence: unit,
      validators: results.map((r) => `${r.validator}@${r.version}:${r.status}`),
    };
    record.reading = reading;
  }
  return record;
}

/** Validate every extraction, then check admitted readings per parameter for ranges and duplicates. */
export function validateExtractions(extractions: IntakeExtraction[], units: IntakeUnit[], ctx: ValidationContext): ExtractionRecord[] {
  const byId = new Map(units.map((u) => [u.evidenceId, u]));
  const records = extractions.map((e) => validateExtraction(e, byId, ctx));

  for (const key of new Set(records.map((r) => r.extraction.field))) {
    const admitted = records.filter((r) => r.extraction.field === key && r.outcome === "ADMITTED" && r.reading);
    // Identical readings of the same unit merge; differing ones go to review together.
    for (const outcome of reconcileDuplicates(admitted.map((r) => r.reading!))) {
      const indexOf = (reading: unknown) => records.findIndex((r) => r.reading === reading);
      if (outcome.status === "MERGED") {
        const kept = indexOf(outcome.kept);
        for (const dropped of outcome.dropped) records[indexOf(dropped)]!.duplicateOf = kept;
      } else {
        for (const reading of outcome.readings) {
          const r = records[indexOf(reading)]!;
          r.outcome = "REVIEW_REQUIRED";
          r.reasonCodes = [...r.reasonCodes, "FACT_CONFLICT"];
          r.results = [...r.results, result("duplicates", "REVIEW_REQUIRED", ["FACT_CONFLICT"], outcome.detail)];
        }
      }
    }
    const stillAdmitted = records.filter((r) => r.extraction.field === key && r.outcome === "ADMITTED" && r.reading && r.duplicateOf === undefined);
    const violations = checkRangeInvariants(stillAdmitted.map((r) => r.reading!));
    if (violations.length > 0) {
      for (const r of stillAdmitted) {
        r.outcome = "REVIEW_REQUIRED";
        r.reasonCodes = [...r.reasonCodes, "FACT_CONFLICT"];
        r.results = [...r.results, result("range-invariants", "REVIEW_REQUIRED", ["FACT_CONFLICT"], violations.map((v) => v.detail).join("; "))];
      }
    }
  }
  return records;
}

/**
 * Condition parser (SPEC §6, §8): raw condition strings → structured
 * ConditionSet. Conditions are parsed, never inferred; footnote markers
 * attach by reference into `notes`.
 */

import type { ConditionSet, Decimal } from "../types";
import { parseMeasurement, UnitError } from "../decimal";
import { NumericParseError, parseNumeric } from "./numeric";

export class ConditionParseError extends Error {
  readonly code = "CONDITION_MISMATCH";
  constructor(readonly input: string, detail: string) {
    super(`unparseable condition '${input}': ${detail}`);
    this.name = "ConditionParseError";
  }
}

/** Datasheet symbol → ConditionSet field. */
const CONDITION_KEYS: Record<string, "vin" | "temperature" | "frequency" | "load"> = {
  VIN: "vin",
  VDD: "vin",
  VCC: "vin",
  TA: "temperature",
  TJ: "temperature",
  TEMP: "temperature",
  F: "frequency",
  FSW: "frequency",
  FREQ: "frequency",
  IOUT: "load",
  ILOAD: "load",
  LOAD: "load",
};

const FOOTNOTE = /^\(\d+\)$/;

const PAIR = /^([A-Za-z]+)\s*=\s*(.+)$/;

const VALUE_WITH_UNIT = /^(.+?)\s*([A-Za-zµΩ°%]+)$/;

function parseValueWithUnit(
  text: string,
  source: string,
): Decimal | { min: Decimal; max: Decimal } {
  const match = VALUE_WITH_UNIT.exec(text.trim());
  if (!match) throw new ConditionParseError(source, `no unit in '${text}'`);
  const [, numberPart, unit] = match;
  try {
    const numeric = parseNumeric(numberPart!);
    switch (numeric.kind) {
      case "value":
        return parseMeasurement(numeric.value, unit!);
      case "range":
        return {
          min: parseMeasurement(numeric.min, unit!),
          max: parseMeasurement(numeric.max, unit!),
        };
      default:
        throw new ConditionParseError(
          source,
          `unsupported numeric form '${numeric.kind}' in a condition`,
        );
    }
  } catch (err) {
    if (err instanceof NumericParseError || err instanceof UnitError) {
      throw new ConditionParseError(source, err.message);
    }
    throw err;
  }
}

/**
 * Parse "VIN = 3.6 V, TA = 25°C, PFM mode, (1)" into a ConditionSet.
 * Unrecognized `KEY = value` pairs are an error (fail closed); bare tokens
 * become `mode`; footnote markers land in `notes` by reference.
 */
export function parseConditions(input: string): ConditionSet {
  const conditions: ConditionSet = {};
  const notes: string[] = [];
  const modes: string[] = [];

  for (const segment of input.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    if (FOOTNOTE.test(segment)) {
      notes.push(segment);
      continue;
    }
    const pair = PAIR.exec(segment);
    if (pair) {
      const field = CONDITION_KEYS[pair[1]!.toUpperCase()];
      if (field === undefined) {
        throw new ConditionParseError(segment, `unknown condition symbol '${pair[1]}'`);
      }
      const value = parseValueWithUnit(pair[2]!, segment);
      if (field === "frequency" || field === "load") {
        if ("min" in value) {
          throw new ConditionParseError(segment, `${field} must be a single value`);
        }
        conditions[field] = value;
      } else {
        conditions[field] = value;
      }
      continue;
    }
    modes.push(segment);
  }

  if (modes.length > 0) conditions.mode = modes.join("; ");
  if (notes.length > 0) conditions.notes = notes;
  return conditions;
}

/** Parse a rawConditions record from a provider (values are raw strings). */
export function parseRawConditions(
  raw: Record<string, string>,
): ConditionSet {
  return parseConditions(
    Object.entries(raw)
      .map(([key, value]) => (PAIR.test(`${key} = ${value}`) ? `${key} = ${value}` : value))
      .join(", "),
  );
}

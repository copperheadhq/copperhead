/**
 * SI unit system with exact power-of-ten conversions (SPEC §6, §8).
 *
 * Every supported unit belongs to a dimension family with a base unit; all
 * in-family conversions are exact decimal shifts. Unknown symbols and
 * cross-dimension conversions are errors — fail closed, never guess.
 */

import type { Decimal } from "../types";
import type { ExactDecimal } from "./exact";
import {
  add as addExact,
  compare as compareExact,
  parseExact,
  shift,
  toDecimalString,
} from "./exact";

export class UnitError extends Error {
  constructor(
    message: string,
    readonly code: "UNIT_UNKNOWN" | "DIMENSION_MISMATCH",
  ) {
    super(message);
    this.name = "UnitError";
  }
}

const PREFIXES: Record<string, number> = {
  p: -12,
  n: -9,
  u: -6,
  "µ": -6,
  m: -3,
  "": 0,
  k: 3,
  M: 6,
  G: 9,
};

interface UnitFamily {
  dimension: string;
  base: string;
  /** Alternate spellings of the base symbol. */
  aliases?: string[];
  /** Prefixable? (%, °C are not) */
  prefixable: boolean;
}

const FAMILIES: UnitFamily[] = [
  { dimension: "current", base: "A", prefixable: true },
  { dimension: "voltage", base: "V", prefixable: true },
  { dimension: "frequency", base: "Hz", prefixable: true },
  { dimension: "resistance", base: "ohm", aliases: ["Ω", "Ohm"], prefixable: true },
  { dimension: "power", base: "W", prefixable: true },
  { dimension: "capacitance", base: "F", prefixable: true },
  { dimension: "inductance", base: "H", prefixable: true },
  { dimension: "time", base: "s", prefixable: true },
  { dimension: "charge", base: "Ah", prefixable: true },
  // Temperature is °C-based; kelvin offset conversion is out of scope (affine,
  // not a decimal shift) and no v1 fact class needs it.
  { dimension: "temperature", base: "C", aliases: ["°C", "degC"], prefixable: false },
  { dimension: "ratio", base: "%", prefixable: false },
];

export interface ParsedUnit {
  symbol: string;
  dimension: string;
  base: string;
  /** Power of ten from this unit to the family base. */
  powerToBase: number;
}

export function parseUnit(symbol: string): ParsedUnit {
  const trimmed = symbol.trim();
  for (const family of FAMILIES) {
    const spellings = [family.base, ...(family.aliases ?? [])];
    if (spellings.includes(trimmed)) {
      return {
        symbol: trimmed,
        dimension: family.dimension,
        base: family.base,
        powerToBase: 0,
      };
    }
    if (family.prefixable) {
      for (const spelling of spellings) {
        if (trimmed.endsWith(spelling) && trimmed.length > spelling.length) {
          const prefix = trimmed.slice(0, trimmed.length - spelling.length);
          const power = PREFIXES[prefix];
          if (power !== undefined) {
            return {
              symbol: trimmed,
              dimension: family.dimension,
              base: family.base,
              powerToBase: power,
            };
          }
        }
      }
    }
  }
  throw new UnitError(`unknown unit symbol '${symbol}'`, "UNIT_UNKNOWN");
}

export function dimensionOf(symbol: string): string {
  return parseUnit(symbol).dimension;
}

/** Exact SI-base value of `value` expressed in `unit`. */
function toBase(value: ExactDecimal, unit: ParsedUnit): ExactDecimal {
  return shift(value, unit.powerToBase);
}

/**
 * Build a §6 Decimal from a raw value string and unit symbol.
 * "0.033" + "mA" → { value_decimal: "0.033", unit: "mA", si_value_decimal: "0.000033" }
 */
export function parseMeasurement(value: string, unitSymbol: string): Decimal {
  const unit = parseUnit(unitSymbol);
  const exact = parseExact(value);
  return {
    value_decimal: toDecimalString(exact),
    unit: unit.symbol,
    si_value_decimal: toDecimalString(toBase(exact, unit)),
  };
}

/** Exactly convert a Decimal to another unit in the same dimension (AC-4.1). */
export function convertTo(decimal: Decimal, targetSymbol: string): Decimal {
  const from = parseUnit(decimal.unit);
  const to = parseUnit(targetSymbol);
  if (from.dimension !== to.dimension) {
    throw new UnitError(
      `cannot convert ${decimal.unit} (${from.dimension}) to ${targetSymbol} (${to.dimension})`,
      "DIMENSION_MISMATCH",
    );
  }
  const base = parseExact(decimal.si_value_decimal);
  return {
    value_decimal: toDecimalString(shift(base, -to.powerToBase)),
    unit: to.symbol,
    si_value_decimal: decimal.si_value_decimal,
  };
}

/** Exact SI value of a Decimal, for arithmetic and comparison. */
export function siValue(decimal: Decimal): ExactDecimal {
  return parseExact(decimal.si_value_decimal);
}

/** Compare two Decimals of the same dimension by exact SI value. */
export function compareMeasurements(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const da = parseUnit(a.unit);
  const db = parseUnit(b.unit);
  if (da.dimension !== db.dimension) {
    throw new UnitError(
      `cannot compare ${a.unit} (${da.dimension}) with ${b.unit} (${db.dimension})`,
      "DIMENSION_MISMATCH",
    );
  }
  return compareExact(siValue(a), siValue(b));
}

/** Exact sum of same-dimension terms, expressed in `resultUnit` (budget_sum). */
export function sumMeasurements(terms: Decimal[], resultUnit: string): Decimal {
  const to = parseUnit(resultUnit);
  let total: ExactDecimal = { digits: 0n, exp: 0 };
  for (const term of terms) {
    const unit = parseUnit(term.unit);
    if (unit.dimension !== to.dimension) {
      throw new UnitError(
        `cannot sum ${term.unit} (${unit.dimension}) into ${resultUnit} (${to.dimension})`,
        "DIMENSION_MISMATCH",
      );
    }
    total = addExact(total, siValue(term));
  }
  return {
    value_decimal: toDecimalString(shift(total, -to.powerToBase)),
    unit: to.symbol,
    si_value_decimal: toDecimalString(total),
  };
}

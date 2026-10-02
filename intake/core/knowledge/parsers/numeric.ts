/**
 * Numeric parser (SPEC §8): decimal, scientific, inequalities, ranges,
 * tolerances. Anything else is VALUE_UNPARSEABLE — never guessed.
 */

import { DecimalParseError, parseExact, toDecimalString } from "../decimal";

export type ParsedNumeric =
  | { kind: "value"; value: string }
  | { kind: "inequality"; op: "<" | "<=" | ">" | ">="; value: string }
  | { kind: "range"; min: string; max: string }
  | { kind: "tolerance"; value: string };

export class NumericParseError extends Error {
  readonly code = "VALUE_UNPARSEABLE";
  constructor(readonly input: string) {
    super(`unparseable numeric value: '${input}'`);
    this.name = "NumericParseError";
  }
}

const INEQUALITY_OPS: Record<string, "<" | "<=" | ">" | ">="> = {
  "<": "<",
  "<=": "<=",
  "≤": "<=",
  ">": ">",
  ">=": ">=",
  "≥": ">=",
};

function exact(text: string, input: string): string {
  try {
    return toDecimalString(parseExact(text));
  } catch (err) {
    if (err instanceof DecimalParseError) throw new NumericParseError(input);
    throw err;
  }
}

export function parseNumeric(input: string): ParsedNumeric {
  const text = input.trim();
  if (text.length === 0) throw new NumericParseError(input);

  const ineq = /^(<=|>=|[<>≤≥])\s*(.+)$/.exec(text);
  if (ineq) {
    return {
      kind: "inequality",
      op: INEQUALITY_OPS[ineq[1]!]!,
      value: exact(ineq[2]!, input),
    };
  }

  const tolerance = /^±\s*(.+)$/.exec(text);
  if (tolerance) {
    return { kind: "tolerance", value: exact(tolerance[1]!, input) };
  }

  // Plain value first, so exponent hyphens ("3.3e-5") never read as ranges.
  try {
    return { kind: "value", value: exact(text, input) };
  } catch {
    // fall through to range forms
  }

  const range =
    /^([+-]?[\d.eE+-]+)\s*(?:to|\.\.|–|—|-)\s*([+-]?\d[\d.eE+-]*)$/.exec(text);
  if (range) {
    return {
      kind: "range",
      min: exact(range[1]!, input),
      max: exact(range[2]!, input),
    };
  }

  throw new NumericParseError(input);
}

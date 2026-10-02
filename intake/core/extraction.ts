// The extraction contract (ground-intake-extraction D3) and the text normalisation the
// validators share. Pure.

import type { Qualifier } from "./knowledge/types";

/** One extracted field as the extractor reports it: a pointer at a unit, never text of its own. */
export interface IntakeExtraction {
  /** The field key asked for. */
  field: string;
  /** The id of the evidence unit holding the value. */
  evidenceId: string;
  /** The value exactly as printed, such as "–0.3", "1,100" or "nine". */
  value: string;
  /** The unit exactly as printed, such as "μA" or "Vdc". */
  unit?: string;
  qualifier?: Qualifier;
  /** Conditions as printed, such as { VCC: "5 V", TA: "25 °C" }. */
  conditions?: Record<string, string>;
  /** True when the value carries a footnote that changes its meaning. */
  footnoteQualified?: boolean;
  /** The extractor's own confidence; used only to route to review. */
  confidence: number;
}

export const EXTRACTION_SCHEMA_VERSION = "extractions-1";

export const QUALIFIERS: readonly Qualifier[] = ["MIN", "TYP", "MAX", "NOM", "ABS_MAX"];

/**
 * Text as the validators compare it: Unicode compatibility form, any dash or minus before a
 * digit as "-", thousands separators between digits removed, cell separators as spaces, and
 * whitespace collapsed.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s*\|\s*/g, " ")
    .replace(/[‐-―−﹣－](?=\s?\d)/g, "-")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A value printed fused with its unit ("7.0V", "1.5uA") as the number and the unit. A unit the
 * extractor also gave must be the same one; otherwise the value is left as printed.
 */
export function splitFusedUnit(value: string, unit: string | undefined): { value: string; unit: string | undefined } {
  const m = /^([-+–−]?\s?\d[\d.,]*)\s*([A-Za-zµμΩΩ°%]+)$/.exec(value.trim());
  if (!m) return { value, unit };
  const [, number, suffix] = m as unknown as [string, string, string];
  if (unit !== undefined && normalizeUnit(unit) !== normalizeUnit(suffix)) return { value, unit };
  return { value: number.trim(), unit: unit ?? suffix };
}

export function normalizeValue(value: string): string {
  return normalizeText(value).replace(/^-\s+/, "-");
}

const UNIT_ALIASES: [RegExp, string][] = [
  [/^([pnumkMG]?)Vdc$/, "$1V"],
  [/^([pnumkMG]?)Adc$/, "$1A"],
  [/^([pnumkMG]?)(Ω|Ω|ohms?|Ohms?)$/, "$1ohm"],
];

/** A unit as cortex's unit table reads it: μ and µ as u, the ohm sign as ohm, Vdc as V. */
export function normalizeUnit(unit: string): string {
  let u = unit.normalize("NFKC").replace(/\s+/g, "").replace(/[μµ]/g, "u");
  for (const [pattern, replacement] of UNIT_ALIASES) u = u.replace(pattern, replacement);
  return u;
}

const WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

/** The word form of 0 to 20, or undefined. */
export function numberWord(value: string): string | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  return WORDS[Number(value)];
}

/** Number words zero to twenty read as their numerals, as cortex's containment check needs. */
export function wordsToNumerals(text: string): string {
  return text.replace(new RegExp(`\\b(${WORDS.join("|")})\\b`, "gi"), (w) => String(WORDS.indexOf(w.toLowerCase())));
}

/** The numeral a number word stands for, or undefined. */
export function wordNumber(word: string): string | undefined {
  const i = WORDS.indexOf(word.toLowerCase());
  return i < 0 ? undefined : String(i);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The positions at which a value occurs in text as a whole number, never inside a longer one. */
export function valueOccurrences(text: string, value: string): number[] {
  // Not inside a longer number: no digit before, no decimal point after a digit before (dot
  // leaders such as "VCC......6.5V" are not decimal points), no digit or decimal part after.
  const re = new RegExp(`(?<!\\d)(?<!\\d\\.)${escape(value)}(?![\\d])(?!\\.\\d)`, "g");
  const out: number[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m.index);
  const word = numberWord(value);
  if (word) {
    const wre = new RegExp(`\\b${word}\\b`, "gi");
    for (let m = wre.exec(text); m; m = wre.exec(text)) out.push(m.index);
  }
  return out.sort((a, b) => a - b);
}

/** Whether a unit occurs in text as a token, not as part of a longer word. */
export function unitOccurs(text: string, unit: string): boolean {
  const t = normalizeUnitText(text);
  const u = normalizeUnit(unit);
  return new RegExp(`(?<![A-Za-z])${escape(u)}(?![A-Za-z])`).test(t);
}

function normalizeUnitText(text: string): string {
  return normalizeText(text)
    .replace(/[μµ]/g, "u")
    .replace(/(\d|\s|^)(Ω|Ω)/g, "$1ohm")
    .replace(/([pnumkMG])(Ω|Ω)/g, "$1ohm")
    .replace(/\b([pnumkMG]?)Vdc\b/g, "$1V")
    .replace(/\b([pnumkMG]?)Adc\b/g, "$1A");
}

const LOWER = /\b(at least|minimum(?: of)?|no less than|not less than|more than|greater than)\s*$/i;
const UPPER = /\b(at most|maximum(?: of)?|up to|within|less than|no more than|not more than|not exceeding|shorter than)\s*$/i;

/**
 * The bound a citation's wording puts on the value at a position: "at least nine" bounds from
 * below, "within 2 mm" from above. Undefined when the wording states no bound, BOTH when it
 * states both.
 */
export function boundWording(text: string, position: number): "MIN" | "MAX" | "BOTH" | undefined {
  const before = text.slice(Math.max(0, position - 40), position);
  const lower = LOWER.test(before);
  const upper = UPPER.test(before);
  if (lower && upper) return "BOTH";
  if (lower) return "MIN";
  if (upper) return "MAX";
  return undefined;
}

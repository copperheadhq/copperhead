// Part pack export (add-part-pack-export): the intake's admitted readings of one datasheet as a
// part pack draft in the format copperhead-tools reads (part-packs v1; Copperhead RFC 4
// Section 6.3). Pure: no I/O, no clock, no YAML library; the scripts serialise.
//
// A draft carries no confirmedBy: the tools list a draft and never use it. A person adds pins, the
// typical circuit and layout guidance as needed, and confirms; confirmation re-checks every quote.

import type { ExtractionRecord } from "./model";
import { isAdmitted } from "./model";
import { normalizeText } from "./extraction";
import type { DocumentRef } from "./knowledge/types";

export const PART_PACK_VERSION = 1;

export const TOPOLOGIES = ["buck", "boost", "buck-boost", "ldo", "load-switch", "charger", "other"] as const;
export type Topology = (typeof TOPOLOGIES)[number];

/** Intake field key to part-pack parameter. The supply range is a regulator's input range, else a supply range. */
export function packParam(field: string, topology: Topology): string | null {
  const regulator = topology !== "other";
  switch (field) {
    case "supply_voltage_V":
      return regulator ? "input-voltage" : "supply-voltage";
    case "abs_max_vin_V":
      return "input-voltage-abs-max";
    case "quiescent_current_uA":
      return "quiescent-current";
    case "feedback_voltage_V":
      return "feedback-voltage";
    case "output_voltage_V":
      return "output-voltage";
    case "output_current_A":
      return "output-current";
    case "current_limit_A":
      return "current-limit";
    case "switching_frequency_Hz":
      return "switching-frequency";
    case "dropout_voltage_V":
      return "dropout-voltage";
    case "enable_threshold_V":
      return "enable-threshold";
    case "junction_temperature_max_C":
      return "junction-temperature-max";
    default:
      return null;
  }
}

export interface PackFact {
  param: string;
  min?: string;
  typ?: string;
  max?: string;
  conditions?: string[];
  page: string;
  quote: string;
}

export interface PackDraft {
  version: 1;
  part: { mpn: string; manufacturer: string; aliases?: string[]; topology: Topology };
  source: { document: string; revision?: string; sha256: string };
  extraction: { by: string; on: string };
  facts: PackFact[];
  /** Said in the draft's header comments; never a key of the pack. */
  notes: string[];
}

export interface DraftInput {
  mpn: string;
  manufacturer: string;
  aliases?: string[];
  topology: Topology;
  /** The datasheet's title as printed. */
  title: string;
  document: DocumentRef;
  records: ExtractionRecord[];
  extractor: string;
  /** YYYY-MM-DD; injected, core never reads the clock. */
  on: string;
}

/** A unit as the tools' quantity parser spells it. */
export function packUnit(unit: string): string {
  const u = unit.normalize("NFKC").replace(/[µμ]/g, "u").replace(/Ω|Ohm/g, "ohm");
  if (/^°?C$/.test(u) || u === "degC") return "degC";
  return u;
}

/**
 * The sibling part numbers a quote names, when it names none of this part's: a family datasheet's row
 * "CCM, AP63203 3.27 3.30 3.33 V" belongs to the AP63203, not the AP63205. A sibling shares the part
 * number's leading letters and first three digits.
 */
export function siblingVariants(quote: string, mpn: string, aliases: string[] = []): string[] {
  const stem = /^[A-Z]+\d{3}/i.exec(mpn)?.[0]?.toUpperCase();
  if (!stem) return [];
  const names = [mpn, ...aliases].map((n) => n.toUpperCase());
  const tokens = (quote.toUpperCase().match(/[A-Z]{1,6}\d{3,}[A-Z0-9-]*/g) ?? []).filter((t) => t.startsWith(stem));
  if (!tokens.length) return [];
  const mine = tokens.some((t) => names.some((n) => n.startsWith(t) || t.startsWith(n)));
  return mine ? [] : [...new Set(tokens)];
}

function conditionsOf(r: ExtractionRecord): string[] {
  return Object.entries(r.extraction.conditions ?? {}).map(([k, v]) => `${k} = ${v}`);
}

/**
 * One fact per evidence unit and parameter: the MIN, TYP (or NOM) and MAX readings an extractor took
 * from one table row become one fact quoting that row. Only admitted readings that are not duplicates
 * enter; held and rejected ones are counted in the notes.
 */
export function draftPack(input: DraftInput): PackDraft {
  const facts = new Map<string, PackFact>();
  let held = 0;
  let unmapped = 0;
  const siblings = new Set<string>();
  const ordered = [...input.records].sort((a, b) => (a.unit?.page ?? 0) - (b.unit?.page ?? 0));
  for (const r of ordered) {
    if (!isAdmitted(r) || r.duplicateOf !== undefined) {
      if (r.outcome !== "ADMITTED") held++;
      continue;
    }
    const param = packParam(r.extraction.field, input.topology);
    if (!param) {
      unmapped++;
      continue;
    }
    const ev = r.reading.evidence;
    const others = siblingVariants(ev.text, input.mpn, input.aliases);
    if (others.length) {
      for (const o of others) siblings.add(o);
      continue;
    }
    const key = `${param}\u0000${ev.evidenceId}`;
    const fact = facts.get(key) ?? { param, page: String(ev.page), quote: normalizeText(ev.text), ...(conditionsOf(r).length ? { conditions: conditionsOf(r) } : {}) };
    const value = `${r.reading.measurement.value_decimal} ${packUnit(r.reading.measurement.unit)}`;
    const q = r.reading.qualifier;
    const slot = q === "MIN" ? "min" : q === "MAX" || q === "ABS_MAX" ? "max" : "typ";
    if (fact[slot] === undefined) fact[slot] = value;
    facts.set(key, fact);
  }
  const found = new Set([...facts.values()].map((f) => f.param));
  const notes = [
    `Drafted by ${input.extractor} from ${input.document.sha256}; not confirmed. A person checks every entry against the datasheet, adds pins, the typical circuit and layout guidance, and confirms with scripts/confirm-pack.ts, which re-checks every quote.`,
    ...(held ? [`${held} extraction(s) were held for review or rejected and are not in this draft.`] : []),
    ...(unmapped ? [`${unmapped} admitted reading(s) have no part-pack parameter.`] : []),
    ...(siblings.size ? [`Readings of other variants (${[...siblings].sort().join(", ")}) were left out.`] : []),
  ];
  const missing = ["input-voltage", "input-voltage-abs-max", "feedback-voltage", "output-voltage", "output-current", "current-limit", "switching-frequency", "dropout-voltage"].filter((p) => !found.has(p));
  if (missing.length) notes.push(`Not found in the datasheet by the extractor: ${missing.join(", ")}.`);
  return {
    version: PART_PACK_VERSION,
    part: { mpn: input.mpn, manufacturer: input.manufacturer, ...(input.aliases?.length ? { aliases: input.aliases } : {}), topology: input.topology },
    source: { document: input.title, ...(input.document.revision ? { revision: input.document.revision } : {}), sha256: input.document.sha256 },
    extraction: { by: input.extractor, on: input.on },
    facts: [...facts.values()],
    notes,
  };
}

/** Every page-and-quote entry a pack holds, with where it is, for verification. */
export interface QuotedEntry {
  where: string;
  page: string;
  quote: string;
}

/**
 * Problems with a pack's citations: a quote that is not on its page of the document. Text is compared
 * after the intake's normalisation (compatibility forms, dashes, thousands separators, whitespace).
 */
export function verifyQuotes(entries: QuotedEntry[], pageText: (page: number) => string | undefined): string[] {
  const problems: string[] = [];
  for (const e of entries) {
    const page = Number(e.page);
    const text = Number.isInteger(page) ? pageText(page) : undefined;
    if (text === undefined) {
      problems.push(`${e.where}: page ${e.page} is not a page of the document`);
      continue;
    }
    if (!normalizeText(text).includes(normalizeText(e.quote))) problems.push(`${e.where}: the quote is not on page ${e.page}: ${JSON.stringify(e.quote.slice(0, 80))}`);
  }
  return problems;
}

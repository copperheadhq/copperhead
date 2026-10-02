/**
 * Deterministic stub extraction provider (SPEC §3.4).
 *
 * Parses segmented row text mechanically — pipe-separated table cells or
 * whitespace tokens. Because it only ever reads literal cell values, embedded
 * instructions in datasheet text are inert data by construction (AC-3.4),
 * and it echoes supplied evidence ids because it never mints its own (AC-3.2).
 */

import type { EvidenceUnit } from "../../../core/knowledge/types";
import type {
  ExtractionProvider,
  FieldRequest,
  ProviderDescriptor,
  RawExtraction,
} from "../../../core/knowledge/provider/kinds";

const KNOWN_UNITS = new Set([
  "V", "mV", "uV", "µV",
  "A", "mA", "uA", "µA", "nA",
  "Hz", "kHz", "MHz",
  "C", "°C",
  "ohm", "Ω", "kΩ",
  "W", "mW", "uW",
  "%",
]);

const PURE_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
const DASH = /^[—–-]$/;
const CONDITION_PAIR = /([A-Za-z]+)\s*=\s*([^,|]+)/g;

interface ParsedRow {
  /** Value slots in table order; null marks a dash (absent) cell. */
  slots: (string | null)[];
  unit?: string;
  conditions: Record<string, string>;
}

function parsePipeRow(text: string): ParsedRow {
  const cells = text.split("|").map((c) => c.trim());
  const slots: (string | null)[] = [];
  let unit: string | undefined;
  const conditions: Record<string, string> = {};
  for (const cell of cells) {
    if (PURE_NUMBER.test(cell)) {
      // Value cells stop accumulating once the unit column is seen — anything
      // after the unit column is prose (conditions, notes, adversarial text).
      if (unit === undefined) slots.push(cell);
    } else if (DASH.test(cell)) {
      if (unit === undefined) slots.push(null);
    } else if (KNOWN_UNITS.has(cell) && unit === undefined && slots.length > 0) {
      unit = cell;
    } else {
      for (const match of cell.matchAll(CONDITION_PAIR)) {
        conditions[match[1]!.toLowerCase()] = match[2]!.trim();
      }
    }
  }
  return { slots, ...(unit !== undefined ? { unit } : {}), conditions };
}

function parseTokenRow(text: string): ParsedRow {
  const tokens = text.split(/\s+/);
  const slots: (string | null)[] = [];
  let unit: string | undefined;
  for (const token of tokens) {
    if (PURE_NUMBER.test(token)) {
      slots.push(token);
    } else if (KNOWN_UNITS.has(token) && slots.length > 0 && unit === undefined) {
      unit = token;
    } else {
      // "±1%" style: percentage embedded in a token.
      const pct = /^±?(\d+(?:\.\d+)?)%/.exec(token);
      if (pct) {
        slots.push(pct[1]!);
        unit ??= "%";
      }
    }
  }
  return { slots, ...(unit !== undefined ? { unit } : {}), conditions: {} };
}

type Slot = "min" | "typ" | "max" | "single";

function requestedSlot(field: FieldRequest): Slot {
  const parts = field.key.toLowerCase().split("_");
  if (parts.includes("min")) return "min";
  if (parts.includes("typ")) return "typ";
  if (parts.includes("max")) return "max";
  return "single";
}

function pickValue(row: ParsedRow, slot: Slot): string | undefined {
  const present = row.slots.filter((s): s is string => s !== null);
  if (present.length === 0) return undefined;
  if (row.slots.length >= 3) {
    // Three positional slots: MIN | TYP | MAX (dashes hold empty positions).
    const [min, typ, max] = row.slots;
    return { min, typ, max, single: typ ?? present[0] }[slot] ?? undefined;
  }
  if (present.length === 1) return present[0];
  // Two values: a range — MIN first, MAX last.
  if (slot === "min") return present[0];
  if (slot === "max") return present[present.length - 1];
  return undefined;
}

const QUALIFIER_BY_SLOT = { min: "MIN", typ: "TYP", max: "MAX" } as const;

export const STUB_EXTRACTION_DESCRIPTOR: ProviderDescriptor = {
  id: "stub-extraction",
  kind: "extraction",
  capabilities: [
    "per-field-confidence",
    "grounding-bbox",
    "grounding-span",
    "async-batch",
    "labeled-samples",
  ],
  configSchema: {},
};

export class StubExtractionProvider implements ExtractionProvider {
  readonly descriptor = STUB_EXTRACTION_DESCRIPTOR;

  extract(input: {
    unit: EvidenceUnit;
    fields: FieldRequest[];
  }): Promise<RawExtraction[]> {
    const isPipeRow = input.unit.text.includes("|");
    const row = isPipeRow
      ? parsePipeRow(input.unit.text)
      : parseTokenRow(input.unit.text);
    // A pipe row answers only fields addressed to it: the field key's
    // leading segment must match the row's parameter cell (IQ <-> iq_typ_mA).
    const rowKey = isPipeRow
      ? input.unit.text.split("|")[0]?.trim().toLowerCase()
      : undefined;

    const extractions: RawExtraction[] = [];
    for (const field of input.fields) {
      if (rowKey !== undefined && field.key.split("_")[0]?.toLowerCase() !== rowKey) {
        continue;
      }
      const slot = requestedSlot(field);
      const value = pickValue(row, slot);
      if (value === undefined) continue;
      const qualifier =
        slot === "single" ? undefined : QUALIFIER_BY_SLOT[slot];
      extractions.push({
        rawField: field.key,
        value,
        ...(row.unit !== undefined ? { unit: row.unit } : {}),
        ...(qualifier !== undefined ? { qualifier } : {}),
        ...(Object.keys(row.conditions).length > 0
          ? { rawConditions: row.conditions }
          : {}),
        confidence: 0.9,
        evidenceId: input.unit.evidenceId,
      });
    }
    return Promise.resolve(extractions);
  }
}

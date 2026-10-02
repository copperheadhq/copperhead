// The validation pipeline (ground-intake-extraction D4; extraction-validation spec).

import { describe, expect, it } from "vitest";
import { boundWording, normalizeText, normalizeUnit, valueOccurrences } from "../core/extraction";
import type { IntakeExtraction } from "../core/extraction";
import { DEFAULT_FIELD_SPECS, type FieldSpec } from "../core/fields";
import type { IntakeUnit } from "../core/text/types";
import { validateExtraction, validateExtractions, type ValidationContext } from "../core/validate";
import { unit } from "./support/fixtures";

const SPECS: FieldSpec[] = [
  ...DEFAULT_FIELD_SPECS,
  { key: "output_voltage_V", description: "output voltage", dimension: "voltage", requiredConditions: [] },
];
const DOC = unit({ text: "" }).document;
const CTX: ValidationContext = {
  specs: SPECS,
  knownDocuments: new Map([[DOC.sha256, DOC]]),
  contributor: "test",
  provider: { id: "test" },
  now: () => "2026-10-02T00:00:00.000Z",
};

const HEADER = [
  { text: "PARAMETER", x0: 0.1, x1: 0.2, index: 0 },
  { text: "TEST CONDITIONS", x0: 0.3, x1: 0.45, index: 1 },
  { text: "MIN", x0: 0.5, x1: 0.53, index: 2 },
  { text: "TYP", x0: 0.58, x1: 0.61, index: 3 },
  { text: "MAX", x0: 0.66, x1: 0.69, index: 4 },
  { text: "UNIT", x0: 0.74, x1: 0.78, index: 5 },
];

// LM555's supply-current row: TYP 3, MAX 6, its unit in a cell spanning the next row.
const SUPPLY_CURRENT = unit({
  evidenceId: "ev-00000000-p1-l7",
  text: "Supply Current | VCC = 5 V, RL = ∞ | 3 | 6",
  context: "PARAMETER | TEST CONDITIONS | MIN | TYP | MAX | UNIT",
  table: "PARAMETER | TEST CONDITIONS | MIN | TYP | MAX | UNIT",
  layout: {
    cells: [
      { text: "Supply Current", x0: 0.1, x1: 0.2, index: 0 },
      { text: "VCC = 5 V, RL = ∞", x0: 0.3, x1: 0.45, index: 1 },
      { text: "3", x0: 0.59, x1: 0.6, index: 2 },
      { text: "6", x0: 0.67, x1: 0.68, index: 3 },
    ],
    header: HEADER,
  },
  neighbors: ["VCC = 15 V, RL = ∞ | 10 | 15 | mA"],
});

function run(extraction: Partial<IntakeExtraction>, u: IntakeUnit = SUPPLY_CURRENT) {
  const e: IntakeExtraction = { field: "quiescent_current_uA", evidenceId: u.evidenceId, value: "6", unit: "mA", qualifier: "MAX", confidence: 0.9, ...extraction };
  return validateExtraction(e, new Map([[u.evidenceId, u]]), CTX);
}

describe("extraction cites evidence units", () => {
  it("admits a correct extraction, its reading citing the unit and its box", () => {
    const r = run({});
    expect(r.outcome).toBe("ADMITTED");
    expect(r.reading?.evidence.evidenceId).toBe(SUPPLY_CURRENT.evidenceId);
    expect(r.reading?.evidence.bbox).toEqual(SUPPLY_CURRENT.bbox);
    expect(r.reading?.measurement).toMatchObject({ value_decimal: "6", unit: "mA" });
  });

  it("rejects an unknown evidence id", () => {
    const r = run({ evidenceId: "ev-841138b7-p9-l4" });
    expect(r.outcome).toBe("REJECTED");
    expect(r.reasonCodes).toEqual(["EVIDENCE_ID_INVALID"]);
    expect(r.reading).toBeUndefined();
  });

  it("rejects a field that was not asked for", () => {
    expect(run({ field: "output_ripple" }).reasonCodes).toEqual(["FIELD_UNKNOWN"]);
  });
});

describe("validator pipeline", () => {
  it("rejects a value not in the cited unit's own text", () => {
    const r = run({ value: "0.8" });
    expect(r.outcome).toBe("REJECTED");
    expect(r.reasonCodes).toContain("CITATION_NOT_CONTAINED");
    expect(r.reasonCodes).toContain("VALUE_NOT_IN_UNIT");
  });

  it("rejects a value that is only in a neighbouring row", () => {
    const r = run({ value: "15" });
    expect(r.outcome).toBe("REJECTED");
    expect(r.reasonCodes).toContain("VALUE_NOT_IN_UNIT");
  });

  it("never matches a value inside a longer number", () => {
    expect(valueOccurrences("Reset Current | 0.1 | 0.4 | mA", "1")).toEqual([]);
    expect(valueOccurrences("Pin 7 Leakage | 1 | 100 | nA", "1")).toHaveLength(1);
  });

  it("rejects a typical value reported as maximum", () => {
    const r = run({ value: "3", qualifier: "MAX" });
    expect(r.outcome).toBe("REJECTED");
    expect(r.reasonCodes).toContain("QUALIFIER_COLUMN_MISMATCH");
  });

  it("accepts the unit from a cell spanning the next row", () => {
    expect(run({ value: "3", qualifier: "TYP" }).outcome).toBe("ADMITTED");
  });

  it("rejects a unit that occurs nowhere in the unit, its context or its neighbours", () => {
    const r = run({ unit: "uA" });
    expect(r.outcome).toBe("REJECTED");
    expect(r.reasonCodes).toContain("UNIT_NOT_CONTAINED");
  });

  it("an absolute maximum table's Value column implies ABS_MAX", () => {
    const u = unit({
      text: "Emitter-Base Voltage | VEB | 7 | Vdc",
      section: "MAXIMUM RATINGS",
      layout: {
        cells: ["Emitter-Base Voltage", "VEB", "7", "Vdc"].map((text, index) => ({ text, index })),
        header: ["Rating", "Symbol", "Value", "Unit"].map((text, index) => ({ text, index })),
      },
    });
    const as = (qualifier: NonNullable<IntakeExtraction["qualifier"]>) =>
      validateExtraction({ field: "abs_max_vin_V", evidenceId: u.evidenceId, value: "7", unit: "Vdc", qualifier, confidence: 0.9 }, new Map([[u.evidenceId, u]]), CTX);
    expect(as("ABS_MAX").outcome).toBe("ADMITTED");
    expect(as("MAX").reasonCodes).toContain("QUALIFIER_COLUMN_MISMATCH");
  });
});

describe("number words and worded bounds", () => {
  const prose = (text: string) => unit({ text });
  const check = (text: string, value: string, qualifier: NonNullable<IntakeExtraction["qualifier"]>) => {
    const u = prose(text);
    return validateExtraction({ field: "output_voltage_V", evidenceId: u.evidenceId, value, unit: "V", qualifier, confidence: 0.9 }, new Map([[u.evidenceId, u]]), CTX);
  };

  it("a number word grounds its numeral", () => {
    expect(valueOccurrences("Use at least nine 0.3-mm vias under the exposed pad.", "9")).toHaveLength(1);
    expect(check("Apply no more than five V to VIN.", "5", "MAX").outcome).toBe("ADMITTED");
  });

  it("'at least' bounds from below and 'within' from above", () => {
    const text = "Use at least nine 0.3-mm vias under the exposed pad.";
    expect(boundWording(text, text.indexOf("nine"))).toBe("MIN");
    const within = "Keep the input within 2 V of the rail.";
    expect(boundWording(within, within.indexOf("2"))).toBe("MAX");
  });

  it("rejects a minimum cited from 'within'", () => {
    const r = check("Keep the input within 2 V of the rail.", "2", "MIN");
    expect(r.outcome).toBe("REJECTED");
    expect(r.reasonCodes).toContain("BOUND_WORDING_MISMATCH");
  });

  it("keeps a bound that matches its wording", () => {
    expect(check("Keep VIN at least 3 V above VOUT.", "3", "MIN").outcome).toBe("ADMITTED");
  });
});

describe("confidence routes and never admits", () => {
  it("routes low confidence to review", () => {
    const r = run({ confidence: 0.4 });
    expect(r.outcome).toBe("REVIEW_REQUIRED");
    expect(r.reasonCodes).toEqual(["LOW_CONFIDENCE"]);
  });

  it("high confidence does not override a validator", () => {
    expect(run({ value: "0.8", confidence: 0.99 }).outcome).toBe("REJECTED");
  });
});

describe("footnotes, normalisation and groups", () => {
  it("holds a footnote-qualified value for review", () => {
    const r = run({ footnoteQualified: true });
    expect(r.outcome).toBe("REVIEW_REQUIRED");
    expect(r.reasonCodes).toContain("FOOTNOTE_QUALIFIED");
  });

  it("reads printed minus signs, thousands separators, μ and Vdc", () => {
    expect(normalizeText("VDD33 | Power supply voltage | –0.3 | 3.6 | V")).toBe("VDD33 Power supply voltage -0.3 3.6 V");
    expect(normalizeText("1,100 mA")).toBe("1100 mA");
    expect(normalizeUnit("μA")).toBe("uA");
    expect(normalizeUnit("µA")).toBe("uA");
    expect(normalizeUnit("Vdc")).toBe("V");
    expect(normalizeUnit("kΩ")).toBe("kohm");
    const u = unit({ text: "Trigger Current | 0.5 | 0.9 | μA" });
    const r = validateExtraction({ field: "pin_input_leakage_uA", evidenceId: u.evidenceId, value: "0.9", unit: "μA", qualifier: "MAX", confidence: 0.9 }, new Map([[u.evidenceId, u]]), CTX);
    expect(r.outcome).toBe("ADMITTED");
    expect(r.reading?.measurement.si_value_decimal).toBe("0.0000009");
  });

  it("a range printed in one cell becomes MIN and MAX readings of one unit", () => {
    const u = unit({ text: "Supply Voltage | 4.5 | 16 | V" });
    const records = validateExtractions(
      [
        { field: "supply_voltage_V", evidenceId: u.evidenceId, value: "4.5", unit: "V", qualifier: "MIN", confidence: 0.9 },
        { field: "supply_voltage_V", evidenceId: u.evidenceId, value: "16", unit: "V", qualifier: "MAX", confidence: 0.9 },
      ],
      [u],
      CTX,
    );
    expect(records.map((r) => r.outcome)).toEqual(["ADMITTED", "ADMITTED"]);
  });

  it("sends a broken range invariant to review", () => {
    const u = unit({ text: "Supply Voltage | 5 | 3 | V" });
    const records = validateExtractions(
      [
        { field: "supply_voltage_V", evidenceId: u.evidenceId, value: "5", unit: "V", qualifier: "MIN", confidence: 0.9 },
        { field: "supply_voltage_V", evidenceId: u.evidenceId, value: "3", unit: "V", qualifier: "MAX", confidence: 0.9 },
      ],
      [u],
      CTX,
    );
    expect(records.map((r) => r.outcome)).toEqual(["REVIEW_REQUIRED", "REVIEW_REQUIRED"]);
    expect(records[0]!.reasonCodes).toContain("FACT_CONFLICT");
  });

  it("merges an identical duplicate", () => {
    const u = unit({ text: "Supply Voltage | 4.5 | 16 | V" });
    const e: IntakeExtraction = { field: "supply_voltage_V", evidenceId: u.evidenceId, value: "16", unit: "V", qualifier: "MAX", confidence: 0.9 };
    const records = validateExtractions([e, { ...e }], [u], CTX);
    expect(records[1]!.duplicateOf).toBe(0);
  });
});

describe("values printed fused with their unit", () => {
  it("reads 7.0V as 7.0 and V", () => {
    const u = unit({ text: "Maximum supply voltage VDD | 7.0V" });
    const r = validateExtraction({ field: "abs_max_vin_V", evidenceId: u.evidenceId, value: "7.0V", qualifier: "ABS_MAX", confidence: 0.9 }, new Map([[u.evidenceId, u]]), CTX);
    expect(r.outcome).toBe("ADMITTED");
    expect(r.reading?.measurement).toMatchObject({ value_decimal: "7", unit: "V" });
  });

  it("leaves a fused value alone when the extractor named a different unit", () => {
    const u = unit({ text: "Maximum supply voltage VDD | 7.0V" });
    const r = validateExtraction({ field: "abs_max_vin_V", evidenceId: u.evidenceId, value: "7.0V", unit: "mV", qualifier: "ABS_MAX", confidence: 0.9 }, new Map([[u.evidenceId, u]]), CTX);
    expect(r.outcome).toBe("REJECTED");
  });
});

describe("the ends of a printed range", () => {
  const check = (text: string, value: string, qualifier: NonNullable<IntakeExtraction["qualifier"]>, field = "abs_max_vin_V") => {
    const u = unit({ text, section: "Absolute Maximum Ratings" });
    return validateExtraction({ field, evidenceId: u.evidenceId, value, unit: "V", qualifier, confidence: 0.9 }, new Map([[u.evidenceId, u]]), CTX);
  };

  it("rejects the lower end of a range claimed as an absolute maximum", () => {
    expect(check("All inputs and outputs w.r.t. VSS -0.3V to VCC + 1.0V", "-0.3", "ABS_MAX").reasonCodes).toContain("RANGE_POSITION_MISMATCH");
    expect(check("Terminal Voltage with Respect to GND | –0.5 to Vdd + 0.5 | V", "–0.5", "ABS_MAX").reasonCodes).toContain("RANGE_POSITION_MISMATCH");
  });

  it("accepts each end of a range under its own qualifier", () => {
    expect(check("Input voltage range | 4.5 to 16 | V", "4.5", "MIN", "supply_voltage_V").outcome).toBe("ADMITTED");
    expect(check("Input voltage range | 4.5 to 16 | V", "16", "MAX", "supply_voltage_V").outcome).toBe("ADMITTED");
    expect(check("Input voltage range | 4.5 to 16 | V", "16", "MIN", "supply_voltage_V").reasonCodes).toContain("RANGE_POSITION_MISMATCH");
  });

  it("does not read separate cells as a range", () => {
    expect(check("VDD33 | Power supply voltage | -0.3 | 3.6 | V", "3.6", "ABS_MAX").outcome).toBe("ADMITTED");
  });
});

describe("dot leaders", () => {
  it("a value after dot leaders is in its line", () => {
    expect(valueOccurrences("VCC.................6.5V", "6.5")).toHaveLength(1);
    expect(valueOccurrences("Reset Voltage 1.5 V", "5")).toEqual([]);
  });

  it("dot leaders before a range are not a range separator", () => {
    const u = unit({ text: "All inputs and outputs w.r.t. VSS ............. -0.3V to VCC +1.0V", section: "Absolute Maximum Ratings" });
    const r = validateExtraction({ field: "abs_max_vin_V", evidenceId: u.evidenceId, value: "-0.3", unit: "V", qualifier: "ABS_MAX", confidence: 0.9 }, new Map([[u.evidenceId, u]]), CTX);
    expect(r.reasonCodes).toContain("RANGE_POSITION_MISMATCH");
  });
});

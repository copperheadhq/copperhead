// Part pack export (add-part-pack-export; part-pack-export spec).

import { describe, expect, it } from "vitest";
import { PACK_FIELD_SPECS } from "../core/fields";
import { draftPack, packParam, packUnit, verifyQuotes } from "../core/pack";
import { validateExtractions, type ValidationContext } from "../core/validate";
import type { IntakeExtraction } from "../core/extraction";
import { unit } from "./support/fixtures";

const HEADER = [
  { text: "PARAMETER", x0: 0.1, x1: 0.2, index: 0 },
  { text: "TEST CONDITIONS", x0: 0.3, x1: 0.45, index: 1 },
  { text: "MIN", x0: 0.5, x1: 0.53, index: 2 },
  { text: "TYP", x0: 0.58, x1: 0.61, index: 3 },
  { text: "MAX", x0: 0.66, x1: 0.69, index: 4 },
  { text: "UNIT", x0: 0.74, x1: 0.78, index: 5 },
];
const FB = unit({
  evidenceId: "ev-00000000-p5-l3",
  page: 5,
  text: "Feedback voltage | TJ = 25°C | 0.588 | 0.600 | 0.612 | V",
  table: "PARAMETER | TEST CONDITIONS | MIN | TYP | MAX | UNIT",
  layout: {
    cells: [
      { text: "Feedback voltage", x0: 0.1, x1: 0.2, index: 0 },
      { text: "TJ = 25°C", x0: 0.3, x1: 0.45, index: 1 },
      { text: "0.588", x0: 0.5, x1: 0.53, index: 2 },
      { text: "0.600", x0: 0.58, x1: 0.61, index: 3 },
      { text: "0.612", x0: 0.66, x1: 0.69, index: 4 },
      { text: "V", x0: 0.74, x1: 0.75, index: 5 },
    ],
    header: HEADER,
  },
});
const ILIM = unit({
  evidenceId: "ev-00000000-p5-l9",
  page: 5,
  text: "High-side current limit | 4 | 5 | A",
  table: "PARAMETER | TEST CONDITIONS | MIN | TYP | MAX | UNIT",
  layout: {
    cells: [
      { text: "High-side current limit", x0: 0.1, x1: 0.2, index: 0 },
      { text: "4", x0: 0.5, x1: 0.53, index: 1 },
      { text: "5", x0: 0.58, x1: 0.61, index: 2 },
      { text: "A", x0: 0.74, x1: 0.75, index: 3 },
    ],
    header: HEADER,
  },
});
const CTX: ValidationContext = {
  specs: PACK_FIELD_SPECS,
  knownDocuments: new Map([[FB.document.sha256, FB.document]]),
  contributor: "test",
  provider: { id: "test" },
  now: () => "2026-10-02T00:00:00.000Z",
};
const ex = (field: string, evidenceId: string, value: string, unitText: string, qualifier: NonNullable<IntakeExtraction["qualifier"]>, confidence = 0.95): IntakeExtraction => ({ field, evidenceId, value, unit: unitText, qualifier, confidence });

describe("part pack export", () => {
  it("maps intake fields to pack parameters, the supply range by topology", () => {
    expect(packParam("supply_voltage_V", "buck")).toBe("input-voltage");
    expect(packParam("supply_voltage_V", "other")).toBe("supply-voltage");
    expect(packParam("abs_max_vin_V", "ldo")).toBe("input-voltage-abs-max");
    expect(packParam("pin_input_leakage_uA", "ldo")).toBeNull();
    expect([packUnit("μA"), packUnit("°C"), packUnit("kΩ"), packUnit("MHz")]).toEqual(["uA", "degC", "kohm", "MHz"]);
  });

  it("drafts one fact per row with its MIN, TYP and MAX, quoting the row, and no confirmedBy", () => {
    const records = validateExtractions(
      [
        ex("feedback_voltage_V", FB.evidenceId, "0.588", "V", "MIN"),
        ex("feedback_voltage_V", FB.evidenceId, "0.600", "V", "TYP"),
        ex("feedback_voltage_V", FB.evidenceId, "0.612", "V", "MAX"),
        ex("current_limit_A", ILIM.evidenceId, "4", "A", "MIN"),
        ex("current_limit_A", ILIM.evidenceId, "9", "A", "MAX"),
      ],
      [FB, ILIM],
      CTX,
    );
    const draft = draftPack({ mpn: "EXA-BUCK-1", manufacturer: "Example", topology: "buck", title: "EXA-BUCK-1 datasheet", document: { ...FB.document, revision: "B" }, records, extractor: "test extractor", on: "2026-10-02" });
    expect(draft).toMatchObject({ version: 1, part: { mpn: "EXA-BUCK-1", topology: "buck" }, source: { document: "EXA-BUCK-1 datasheet", revision: "B", sha256: "0".repeat(64) }, extraction: { by: "test extractor", on: "2026-10-02" } });
    expect(draft).not.toHaveProperty("confirmedBy");
    expect(draft.facts).toEqual([
      { param: "feedback-voltage", min: "0.588 V", typ: "0.6 V", max: "0.612 V", page: "5", quote: "Feedback voltage TJ = 25°C 0.588 0.600 0.612 V" },
      { param: "current-limit", min: "4 A", page: "5", quote: "High-side current limit 4 5 A" },
    ]);
    expect(draft.notes.some((n) => /1 extraction\(s\) were held for review or rejected/.test(n))).toBe(true);
    expect(draft.notes.at(-1)).toMatch(/^Not found in the datasheet by the extractor: input-voltage, /);
  });

  it("leaves out the readings of a family datasheet's other variants", async () => {
    const { siblingVariants } = await import("../core/pack");
    expect(siblingVariants("VFB Feedback Voltage CCM, AP63203 3.27 3.30 3.33 V", "AP63205WU")).toEqual(["AP63203"]);
    expect(siblingVariants("CCM, AP63205 4.95 5.00 5.05 V", "AP63205WU")).toEqual([]);
    expect(siblingVariants("CCM, AP63200/AP63201 792 800 808 mV", "AP63205WU")).toEqual(["AP63200", "AP63201"]);
    expect(siblingVariants("VIN Supply Voltage 3.8 32 V", "AP63205WU")).toEqual([]);
  });

  it("finds a quote on its page after normalisation, and reports one that is not there", () => {
    const pages = new Map([[5, "Feedback voltage   TJ = 25°C  0.588  0.600  0.612  V\nHigh-side current limit 4 5 A"]]);
    expect(verifyQuotes([{ where: "facts[0]", page: "5", quote: "Feedback voltage TJ = 25°C 0.588 0.600 0.612 V" }], (p) => pages.get(p))).toEqual([]);
    expect(verifyQuotes([
      { where: "facts[1]", page: "5", quote: "Feedback voltage 0.6 V" },
      { where: "layout[0]", page: "9", quote: "Place the capacitor" },
    ], (p) => pages.get(p))).toEqual([
      'facts[1]: the quote is not on page 5: "Feedback voltage 0.6 V"',
      "layout[0]: page 9 is not a page of the document",
    ]);
  });
});

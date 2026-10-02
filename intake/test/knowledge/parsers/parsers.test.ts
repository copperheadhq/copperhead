import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { NumericParseError, parseNumeric } from "../../../core/knowledge/parsers/numeric";
import { parseQualifier } from "../../../core/knowledge/parsers/qualifier";
import { ConditionParseError, parseConditions } from "../../../core/knowledge/parsers/conditions";

describe("numeric parser (SPEC §8)", () => {
  it("parses plain and scientific decimals", () => {
    expect(parseNumeric("0.033")).toEqual({ kind: "value", value: "0.033" });
    expect(parseNumeric("3.3e-5")).toEqual({ kind: "value", value: "0.000033" });
    expect(parseNumeric("-40")).toEqual({ kind: "value", value: "-40" });
  });

  it("parses inequalities", () => {
    expect(parseNumeric("< 1")).toEqual({ kind: "inequality", op: "<", value: "1" });
    expect(parseNumeric("≤0.5")).toEqual({ kind: "inequality", op: "<=", value: "0.5" });
    expect(parseNumeric(">= 1.8")).toEqual({ kind: "inequality", op: ">=", value: "1.8" });
  });

  it("parses ranges and tolerances", () => {
    expect(parseNumeric("1.8 to 6.5")).toEqual({ kind: "range", min: "1.8", max: "6.5" });
    expect(parseNumeric("1.8–6.5")).toEqual({ kind: "range", min: "1.8", max: "6.5" });
    expect(parseNumeric("±1")).toEqual({ kind: "tolerance", value: "1" });
  });

  it("fails closed on garbage (VALUE_UNPARSEABLE)", () => {
    for (const bad of ["", "n/a", "TBD", "1..2..3", "approx 5"]) {
      expect(() => parseNumeric(bad)).toThrow(NumericParseError);
    }
  });

  it("never produces a non-decimal output (property)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          const parsed = parseNumeric(s);
          const values =
            parsed.kind === "range" ? [parsed.min, parsed.max] : [parsed.value];
          for (const v of values) expect(v).toMatch(/^-?\d+(\.\d+)?$/);
        } catch (err) {
          expect(err).toBeInstanceOf(NumericParseError);
        }
      }),
    );
  });
});

describe("qualifier parser (SPEC §8)", () => {
  it("recognizes standard headers", () => {
    expect(parseQualifier("MIN")).toBe("MIN");
    expect(parseQualifier("Typ.")).toBe("TYP");
    expect(parseQualifier("maximum")).toBe("MAX");
    expect(parseQualifier("Nom")).toBe("NOM");
    expect(parseQualifier("Absolute  Maximum")).toBe("ABS_MAX");
  });

  it("returns undefined for unknown labels — never guesses", () => {
    expect(parseQualifier("Value")).toBeUndefined();
    expect(parseQualifier("")).toBeUndefined();
  });
});

describe("condition parser (SPEC §6, §8)", () => {
  it("parses key = value pairs into structured fields", () => {
    const conditions = parseConditions("VIN = 3.6 V, TA = 25°C");
    expect(conditions.vin).toEqual({
      value_decimal: "3.6",
      unit: "V",
      si_value_decimal: "3.6",
    });
    expect(conditions.temperature).toEqual({
      value_decimal: "25",
      unit: "°C",
      si_value_decimal: "25",
    });
  });

  it("parses range conditions", () => {
    const conditions = parseConditions("VIN = 1.8 to 6.5 V");
    expect(conditions.vin).toEqual({
      min: { value_decimal: "1.8", unit: "V", si_value_decimal: "1.8" },
      max: { value_decimal: "6.5", unit: "V", si_value_decimal: "6.5" },
    });
  });

  it("captures modes and footnotes by reference (AC-5.2)", () => {
    const conditions = parseConditions("PFM mode, VIN = 3 V, (1)");
    expect(conditions.mode).toBe("PFM mode");
    expect(conditions.notes).toEqual(["(1)"]);
  });

  it("fails closed on unknown condition symbols", () => {
    expect(() => parseConditions("XYZZY = 5 V")).toThrow(ConditionParseError);
    expect(() => parseConditions("VIN = about five")).toThrow(ConditionParseError);
  });
});

import { describe, expect, it } from "vitest";
import {
  compareMeasurements,
  convertTo,
  dimensionOf,
  parseMeasurement,
  parseUnit,
  sumMeasurements,
  UnitError,
} from "../../../core/knowledge/decimal/units";

describe("SI unit system (SPEC §6, §8)", () => {
  it("normalizes 0.033 mA to exactly 33 uA (AC-4.1)", () => {
    const measured = parseMeasurement("0.033", "mA");
    expect(measured).toEqual({
      value_decimal: "0.033",
      unit: "mA",
      si_value_decimal: "0.000033",
    });
    expect(convertTo(measured, "uA")).toEqual({
      value_decimal: "33",
      unit: "uA",
      si_value_decimal: "0.000033",
    });
  });

  it("parses prefixed and aliased symbols", () => {
    expect(parseUnit("µA").dimension).toBe("current");
    expect(parseUnit("kΩ").dimension).toBe("resistance");
    expect(parseUnit("°C").dimension).toBe("temperature");
    expect(parseUnit("MHz").powerToBase).toBe(6);
  });

  it("rejects unknown symbols (UNIT_UNKNOWN)", () => {
    expect(() => parseUnit("furlongs")).toThrow(UnitError);
    expect(dimensionOf.bind(null, "mAh2")).toThrow(UnitError);
  });

  it("refuses cross-dimension conversion and comparison (DIMENSION_MISMATCH)", () => {
    const volts = parseMeasurement("3.3", "V");
    expect(() => convertTo(volts, "uA")).toThrow(UnitError);
    expect(() =>
      compareMeasurements(volts, parseMeasurement("1", "mA")),
    ).toThrow(UnitError);
  });

  it("compares across prefixes exactly", () => {
    expect(
      compareMeasurements(
        parseMeasurement("24.9", "uA"),
        parseMeasurement("0.025", "mA"),
      ),
    ).toBe(-1);
    expect(
      compareMeasurements(
        parseMeasurement("25", "uA"),
        parseMeasurement("0.025", "mA"),
      ),
    ).toBe(0);
  });

  it("sums budget terms exactly (AC-8.4 groundwork)", () => {
    const total = sumMeasurements(
      [parseMeasurement("8", "uA"), parseMeasurement("0.025", "mA")],
      "uA",
    );
    expect(total.value_decimal).toBe("33");
    const boundary = sumMeasurements(
      [parseMeasurement("8", "uA"), parseMeasurement("17", "uA")],
      "uA",
    );
    expect(boundary.value_decimal).toBe("25");
  });
});

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  add,
  compare,
  DecimalParseError,
  parseExact,
  subtract,
  toDecimalString,
} from "../../../core/knowledge/decimal/exact";

describe("exact decimal arithmetic (SPEC §6 — never floats)", () => {
  it("parses and prints canonically", () => {
    expect(toDecimalString(parseExact("0.033"))).toBe("0.033");
    expect(toDecimalString(parseExact("33.000"))).toBe("33");
    expect(toDecimalString(parseExact("3.3e-5"))).toBe("0.000033");
    expect(toDecimalString(parseExact("-1.50"))).toBe("-1.5");
    expect(toDecimalString(parseExact("0.0"))).toBe("0");
  });

  it("rejects non-decimal input", () => {
    for (const bad of ["", "abc", "1.2.3", "0x10", "NaN", "1,5"]) {
      expect(() => parseExact(bad)).toThrow(DecimalParseError);
    }
  });

  it("adds exactly where binary floats cannot", () => {
    // 0.1 + 0.2 === 0.3 exactly (impossible in IEEE754).
    expect(toDecimalString(add(parseExact("0.1"), parseExact("0.2")))).toBe("0.3");
    expect(
      toDecimalString(add(parseExact("0.000008"), parseExact("0.000025"))),
    ).toBe("0.000033");
  });

  it("compares across magnitudes", () => {
    expect(compare(parseExact("0.0000249"), parseExact("0.000025"))).toBe(-1);
    expect(compare(parseExact("0.000025"), parseExact("0.000025"))).toBe(0);
    expect(compare(parseExact("0.0000251"), parseExact("0.000025"))).toBe(1);
  });

  it("round-trips arbitrary decimal strings (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
        fc.integer({ min: -20, max: 20 }),
        (digits, exp) => {
          const printed = toDecimalString({ digits, exp });
          expect(toDecimalString(parseExact(printed))).toBe(printed);
        },
      ),
    );
  });

  it("addition is commutative and subtraction inverts it (property)", () => {
    const dec = fc
      .tuple(
        fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }),
        fc.integer({ min: -15, max: 15 }),
      )
      .map(([digits, exp]) => ({ digits, exp }));
    fc.assert(
      fc.property(dec, dec, (a, b) => {
        expect(toDecimalString(add(a, b))).toBe(toDecimalString(add(b, a)));
        expect(toDecimalString(subtract(add(a, b), b))).toBe(toDecimalString(a));
      }),
    );
  });
});

/**
 * Exact decimal arithmetic over BigInt-scaled values.
 *
 * value = digits × 10^exp. All operations are exact; there is no rounding
 * anywhere. Floats never appear (SPEC §6: decimals are strings).
 */

export interface ExactDecimal {
  digits: bigint;
  exp: number;
}

export class DecimalParseError extends Error {
  constructor(readonly input: string) {
    super(`not an exact decimal: '${input}'`);
    this.name = "DecimalParseError";
  }
}

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

export function parseExact(input: string): ExactDecimal {
  const match = DECIMAL_RE.exec(input.trim());
  if (!match) throw new DecimalParseError(input);
  const [, sign, whole, frac = "", exponent = "0"] = match;
  const digits = BigInt((sign === "-" ? "-" : "") + whole! + frac);
  const exp = Number(exponent) - frac.length;
  return normalize({ digits, exp });
}

export function normalize(d: ExactDecimal): ExactDecimal {
  if (d.digits === 0n) return { digits: 0n, exp: 0 };
  let { digits, exp } = d;
  while (digits % 10n === 0n) {
    digits /= 10n;
    exp += 1;
  }
  return { digits, exp };
}

/** Shift by a power of ten (exact — used for SI prefix conversion). */
export function shift(d: ExactDecimal, powerOfTen: number): ExactDecimal {
  return normalize({ digits: d.digits, exp: d.exp + powerOfTen });
}

function aligned(a: ExactDecimal, b: ExactDecimal): [bigint, bigint, number] {
  const exp = Math.min(a.exp, b.exp);
  return [
    a.digits * 10n ** BigInt(a.exp - exp),
    b.digits * 10n ** BigInt(b.exp - exp),
    exp,
  ];
}

export function add(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const [da, db, exp] = aligned(a, b);
  return normalize({ digits: da + db, exp });
}

export function subtract(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const [da, db, exp] = aligned(a, b);
  return normalize({ digits: da - db, exp });
}

export function compare(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  const [da, db] = aligned(a, b);
  return da < db ? -1 : da > db ? 1 : 0;
}

export function isNegative(d: ExactDecimal): boolean {
  return d.digits < 0n;
}

/** Canonical plain-notation string: no exponent, no trailing zeros. */
export function toDecimalString(d: ExactDecimal): string {
  const n = normalize(d);
  const sign = n.digits < 0n ? "-" : "";
  const abs = (n.digits < 0n ? -n.digits : n.digits).toString();
  if (n.exp >= 0) return sign + abs + "0".repeat(n.exp);
  const pointAt = abs.length + n.exp;
  if (pointAt > 0) {
    return sign + abs.slice(0, pointAt) + "." + abs.slice(pointAt);
  }
  return sign + "0." + "0".repeat(-pointAt) + abs;
}

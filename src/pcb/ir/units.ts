/**
 * Units for the PCB IR (RFC 11 §6.1): integer nanometres for length,
 * millidegrees for angle. KiCad files carry millimetres with up to six
 * decimals, which is exactly nanometre precision, so the conversion is
 * lossless in both directions.
 */

/** Length in integer nanometres. */
export type Nm = number;
/** Angle in integer millidegrees, counter-clockwise positive in KiCad's Y-down frame. */
export type Mdeg = number;

export const NM_PER_MM = 1_000_000;

export function mmToNm(mm: number): Nm {
  return Math.round(mm * NM_PER_MM);
}

/** Millimetres formatted the way KiCad writes them: up to six decimals, no trailing zeros. */
export function nmToMm(nm: Nm): string {
  const s = (nm / NM_PER_MM).toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

export function nmToMmNumber(nm: Nm): number {
  return nm / NM_PER_MM;
}

export function degToMdeg(deg: number): Mdeg {
  return Math.round(deg * 1000);
}

export function mdegToDeg(mdeg: Mdeg): number {
  return mdeg / 1000;
}

/** Normalise an angle into [0, 360000). */
export function normMdeg(mdeg: Mdeg): Mdeg {
  const m = mdeg % 360_000;
  return m < 0 ? m + 360_000 : m;
}

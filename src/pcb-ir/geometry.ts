import type { Pose } from './types.generated.js';

/**
 * Poses and transforms in integer nanometres (RFC 11 Section 6.1). A quarter
 * turn is exact; an angle in millidegrees is rounded once to the nanometre,
 * halves away from zero.
 */

export type Rotation = Pose['rot'];
export type Side = 'front' | 'back';

export function rotationMdeg(rot: Rotation): number {
  return 'q' in rot ? rot.q * 90_000 : rot.mdeg;
}

/** The one written form of an angle: quarter turns where it is a multiple of 90 degrees. */
export function rotationOf(mdeg: number): Rotation {
  const m = ((mdeg % 360_000) + 360_000) % 360_000;
  return m % 90_000 === 0 ? { q: (m / 90_000) as 0 | 1 | 2 | 3 } : { mdeg: m };
}

export function sameRotation(a: Rotation, b: Rotation): boolean {
  return rotationMdeg(a) === rotationMdeg(b);
}

function roundHalfAway(v: number): number {
  return Math.sign(v) * Math.round(Math.abs(v));
}

/** Counter-clockwise as seen from the front: (x cos a + y sin a, -x sin a + y cos a). */
export function rotatePoint(x: number, y: number, rot: Rotation): [number, number] {
  if ('q' in rot) {
    switch (rot.q) {
      case 0:
        return [x, y];
      case 1:
        return [y, -x];
      case 2:
        return [-x, -y];
      case 3:
        return [-y, x];
    }
  }
  const a = ((rot.mdeg / 1000) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [roundHalfAway(x * c + y * s), roundHalfAway(-x * s + y * c)];
}

/**
 * A block member's pose on the board: the block's transform composed with the
 * member's pose in the block frame. A back-side block mirrors the member first,
 * negating its x and its angle, as a back-side footprint point is mirrored.
 */
export function composePose(transform: Pose, side: Side, member: Pose): Pose {
  const mx = side === 'back' ? -member.x : member.x;
  const mrot = side === 'back' ? -rotationMdeg(member.rot) : rotationMdeg(member.rot);
  const [rx, ry] = rotatePoint(mx, member.y, transform.rot);
  return { x: transform.x + rx, y: transform.y + ry, rot: rotationOf(rotationMdeg(transform.rot) + mrot) };
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

/** The straight-line distance between two positions, in nanometres, rounded half away from zero. */
export function distanceNm(ax: number, ay: number, bx: number, by: number): number {
  const dx = BigInt(ax - bx);
  const dy = BigInt(ay - by);
  const d2 = dx * dx + dy * dy;
  let r = isqrt(d2);
  if (4n * d2 >= (2n * r + 1n) ** 2n) r += 1n;
  return Number(r);
}

function exactDecimal(units: number, scale: number, places: number): string {
  const neg = units < 0;
  const a = Math.abs(units);
  const whole = Math.floor(a / scale);
  const frac = String(a % scale)
    .padStart(places, '0')
    .replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

/** Nanometres as exact millimetres, without trailing zeros: 10780000 is "10.78". */
export function mm(nm: number): string {
  return exactDecimal(nm, 1_000_000, 6);
}

/** An angle as exact degrees: a quarter turn of 3 is "270". */
export function degrees(rot: Rotation): string {
  return exactDecimal(rotationMdeg(rot), 1000, 3);
}

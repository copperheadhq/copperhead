// copperhead patch P1 (not upstream): local replacement for the parts of @tscircuit/math-utils the packer uses.

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** An axis-aligned box given by its centre and size. */
export interface Box {
  center: Point;
  width: number;
  height: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function boxBounds(box: Box): Bounds {
  const hw = box.width / 2;
  const hh = box.height / 2;
  return { minX: box.center.x - hw, maxX: box.center.x + hw, minY: box.center.y - hh, maxY: box.center.y + hh };
}

/**
 * Euclidean gap between two axis-aligned boxes (0 when they touch or overlap),
 * with a nearest point on each box.
 *
 * Every caller in the packer compares `distance` against `minGap`, so
 * `distance` is the exact gap. This deliberately differs from
 * @tscircuit/math-utils 0.0.38, whose version measures between each centre
 * clamped into the other box. That overestimates the gap whenever the boxes'
 * projections overlap on one axis and their centres are offset along it. For
 * example, boxes [-1,1]x[-5,5] and [2,4]x[-1,9] are 1 apart, but that version
 * reports 4.12, so a minGap of 2 would pass. It still reports 0 for real
 * overlaps. See VENDORED.md, P1.
 */
export function computeDistanceBetweenBoxes(
  boxA: Box,
  boxB: Box,
): { distance: number; pointA: Point; pointB: Point } {
  const a = boxBounds(boxA);
  const b = boxBounds(boxB);
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  if (dx === 0 && dy === 0) {
    return { distance: 0, pointA: boxA.center, pointB: boxB.center };
  }
  // Nearest points: on each axis with a gap, the facing edges; on an axis
  // whose projections overlap, the middle of the overlap.
  const ox0 = Math.max(a.minX, b.minX);
  const ox1 = Math.min(a.maxX, b.maxX);
  const oy0 = Math.max(a.minY, b.minY);
  const oy1 = Math.min(a.maxY, b.maxY);
  const pointA: Point = {
    x: dx > 0 ? (a.maxX < b.minX ? a.maxX : a.minX) : (ox0 + ox1) / 2,
    y: dy > 0 ? (a.maxY < b.minY ? a.maxY : a.minY) : (oy0 + oy1) / 2,
  };
  const pointB: Point = {
    x: dx > 0 ? (a.maxX < b.minX ? b.minX : b.maxX) : pointA.x,
    y: dy > 0 ? (a.maxY < b.minY ? b.minY : b.maxY) : pointA.y,
  };
  return { distance: Math.hypot(dx, dy), pointA, pointB };
}

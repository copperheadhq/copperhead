// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/math/rotatePoint.ts
import type { Point } from "../local/math-utils.js"

/** Rotate `point` around `origin` by `angle` (radians). */
export const rotatePoint = (
  point: Point,
  angle: number,
  origin: Point = { x: 0, y: 0 },
): Point => {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = point.x - origin.x
  const dy = point.y - origin.y

  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  }
}

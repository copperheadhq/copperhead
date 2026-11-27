// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/geometry/convexHull.ts
import type { Point } from "../local/math-utils.js"
import { cross } from "../math/cross.js"

/** Monotone-chain convex-hull.  O(n log n). */
export const convexHull = (points: Point[]): Point[] => {
  if (points.length < 3) return [...points]

  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)

  const lower: Point[] = []
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0
    )
      lower.pop()
    lower.push(p)
  }

  const upper: Point[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p!) <= 0
    )
      upper.pop()
    upper.push(p!)
  }

  upper.pop()
  lower.pop()

  return lower.concat(upper)
}

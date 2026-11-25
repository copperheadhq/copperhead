// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/math/expandSegment.ts
import type { Point } from "../local/math-utils.js"

export const expandSegment = (
  segment: [Point, Point],
  amount: number,
): [Point, Point] => {
  const [p1, p2] = segment
  const direction = {
    x: p2.x - p1.x,
    y: p2.y - p1.y,
  }
  const normalizedDirection = normalizeVector(direction)

  const expandedSegment: [Point, Point] = [
    {
      x: p1.x - normalizedDirection.x * amount,
      y: p1.y - normalizedDirection.y * amount,
    },
    {
      x: p2.x + normalizedDirection.x * amount,
      y: p2.y + normalizedDirection.y * amount,
    },
  ]
  return expandedSegment
}

function normalizeVector(direction: { x: number; y: number }) {
  const length = Math.hypot(direction.x, direction.y)
  return {
    x: direction.x / length,
    y: direction.y / length,
  }
}

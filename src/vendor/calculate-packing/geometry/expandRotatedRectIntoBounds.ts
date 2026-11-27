// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/geometry/expandRotatedRectIntoBounds.ts
import type { Bounds } from "../local/math-utils.js"
import { rotatePoint } from "../math/rotatePoint.js"

/**
 * Expand `bounds` to include all four corners of a rectangle after rotation
 * and optional translation. Mutates `bounds` in place.
 */
export function expandRotatedRectIntoBounds(opts: {
  bounds: Bounds
  center: { x: number; y: number }
  width: number
  height: number
  angleRad: number
  translate?: { x: number; y: number }
}): void {
  const { bounds, center, width, height, angleRad } = opts
  const tx = opts.translate?.x ?? 0
  const ty = opts.translate?.y ?? 0
  const hw = width / 2
  const hh = height / 2

  const corners = [
    { x: center.x - hw, y: center.y - hh },
    { x: center.x + hw, y: center.y - hh },
    { x: center.x + hw, y: center.y + hh },
    { x: center.x - hw, y: center.y + hh },
  ]

  for (const corner of corners) {
    const rotated = rotatePoint(corner, angleRad)
    const x = rotated.x + tx
    const y = rotated.y + ty
    bounds.minX = Math.min(bounds.minX, x)
    bounds.maxX = Math.max(bounds.maxX, x)
    bounds.minY = Math.min(bounds.minY, y)
    bounds.maxY = Math.max(bounds.maxY, y)
  }
}

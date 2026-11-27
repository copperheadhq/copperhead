// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/geometry/combineBounds.ts
import type { Bounds } from "../local/math-utils.js"

export const combineBounds = (bounds: Bounds[]) => {
  const minX = Math.min(...bounds.map((b) => b.minX))
  const minY = Math.min(...bounds.map((b) => b.minY))
  const maxX = Math.max(...bounds.map((b) => b.maxX))
  const maxY = Math.max(...bounds.map((b) => b.maxY))
  return { minX, minY, maxX, maxY }
}

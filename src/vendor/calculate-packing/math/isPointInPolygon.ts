// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/math/isPointInPolygon.ts
import type { Point } from "../local/math-utils.js"

/**
 * Check if a point is inside a polygon using the ray casting algorithm
 * @param point The point to check
 * @param polygon Array of points defining the polygon (can be open or closed)
 * @returns true if the point is inside the polygon
 */
export function isPointInPolygon(
  point: Point,
  polygon: Array<{ x: number; y: number }>,
): boolean {
  if (polygon.length < 3) return false

  let inside = false
  const n = polygon.length

  // Ensure polygon is closed for the algorithm
  const poly = [...polygon]
  if (poly[0]!.x !== poly[n - 1]!.x || poly[0]!.y !== poly[n - 1]!.y) {
    poly.push({ ...poly[0]! })
  }

  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x
    const yi = poly[i]!.y
    const xj = poly[j]!.x
    const yj = poly[j]!.y

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi

    if (intersect) inside = !inside
  }

  return inside
}

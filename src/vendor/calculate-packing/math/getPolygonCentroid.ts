// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/math/getPolygonCentroid.ts
import type { Point } from "../local/math-utils.js"

/**
 * Calculates the centroid of a polygon using the area-weighted formula.
 * This is the true geometric centroid, not just the average of vertices.
 *
 * For a polygon with vertices (x₀,y₀), (x₁,y₁), ..., (xₙ,yₙ):
 * - Cx = (1 / 6A) * Σ (xᵢ + xᵢ₊₁)(xᵢyᵢ₊₁ - xᵢ₊₁yᵢ)
 * - Cy = (1 / 6A) * Σ (yᵢ + yᵢ₊₁)(xᵢyᵢ₊₁ - xᵢ₊₁yᵢ)
 *
 * where A is the signed area of the polygon.
 *
 * The centroid is guaranteed to be inside the polygon only for convex polygons.
 * For non-convex polygons, the centroid may lie outside the polygon boundary.
 */
export function getPolygonCentroid(points: Point[]): Point {
  if (points.length < 3) {
    // For degenerate cases, return the average of points
    const sumX = points.reduce((sum, p) => sum + p.x, 0)
    const sumY = points.reduce((sum, p) => sum + p.y, 0)
    return { x: sumX / points.length, y: sumY / points.length }
  }

  let signedArea = 0
  let cx = 0
  let cy = 0

  for (let i = 0; i < points.length; i++) {
    const p1 = points[i]!
    const p2 = points[(i + 1) % points.length]!

    const crossProduct = p1.x * p2.y - p2.x * p1.y
    signedArea += crossProduct
    cx += (p1.x + p2.x) * crossProduct
    cy += (p1.y + p2.y) * crossProduct
  }

  signedArea *= 0.5
  const area = Math.abs(signedArea)

  // Handle degenerate case where area is zero
  if (area < 1e-10) {
    const sumX = points.reduce((sum, p) => sum + p.x, 0)
    const sumY = points.reduce((sum, p) => sum + p.y, 0)
    return { x: sumX / points.length, y: sumY / points.length }
  }

  cx /= 6 * signedArea
  cy /= 6 * signedArea

  return { x: cx, y: cy }
}

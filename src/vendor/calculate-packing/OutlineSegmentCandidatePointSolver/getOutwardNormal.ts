// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/OutlineSegmentCandidatePointSolver/getOutwardNormal.ts
import type { Point } from "../local/math-utils.js"

/**
 * Get the normal direction pointing toward FREE SPACE for component placement.
 *
 * For the obstacles polygon (B - A) returned by constructOutlinesFromPackedComponents:
 * - CCW outlines (positive area): outer boundaries of obstacle islands
 *   → Free space is OUTSIDE the polygon → return geometric outward normal
 * - CW outlines (negative area): holes within obstacles (free space pockets)
 *   → Free space is INSIDE the polygon → return geometric INWARD normal
 *
 * This ensures the LargestRectOutsideOutlineFromPointSolver searches in the
 * correct direction for component placement.
 */
export function getOutwardNormal(
  outlineSegment: [Point, Point],
  ccwFullOutline: [Point, Point][],
): Point {
  const [p1, p2] = outlineSegment
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy)

  if (len === 0) {
    return { x: 0, y: 1 } // Default normal for degenerate segment
  }

  // Normalized segment direction
  const dirX = dx / len
  const dirY = dy / len

  // Two possible normals (perpendicular to segment)
  const left = { x: -dirY, y: dirX }
  const right = { x: dirY, y: -dirX }

  // Calculate signed area to determine winding direction
  const verts: Point[] = []
  if (ccwFullOutline.length > 0) {
    verts.push(ccwFullOutline[0]![0])
    for (const seg of ccwFullOutline) {
      verts.push(seg[1]!)
    }
  }
  const signedArea = (() => {
    let a = 0
    for (let i = 0; i < verts.length; i++) {
      const v1 = verts[i]!
      const v2 = verts[(i + 1) % verts.length]!
      a += v1.x * v2.y - v2.x * v1.y
    }
    return a / 2
  })()

  // Determine the geometric outward normal based on winding
  // CCW (positive area): outward is right (perpendicular to walking direction)
  // CW (negative area): outward is left
  const geometricOutward = signedArea > 0 ? right : left

  // For CW outlines (holes/free space pockets), we want to search INSIDE
  // the polygon (where the free space is), not outside.
  // So we INVERT the normal for CW outlines.
  const isCW = signedArea < 0
  if (isCW) {
    // For CW outlines, return the INWARD normal (toward free space inside the hole)
    return { x: -geometricOutward.x, y: -geometricOutward.y }
  }

  // For CCW outlines, return the geometric outward normal (toward free space outside)
  return geometricOutward
}

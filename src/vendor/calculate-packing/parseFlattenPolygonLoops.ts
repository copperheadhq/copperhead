// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/parseFlattenPolygonLoops.ts
import type Flatten from "@flatten-js/core"
import type { Point } from "./local/math-utils.js"

/**
 * Parsed outline loops from a flatten-js polygon.
 *
 * Flatten-js convention (verified by tests):
 * - CCW loops (positive signed area) = outer boundaries
 * - CW loops (negative signed area) = inner boundaries (holes/subtracted areas)
 *
 * Semantic mapping for packing:
 * - obstacleFreeLoop: CCW loops representing the boundary of free space
 *   (outer edge of the packing area)
 * - obstacleContainingLoop: CW loops representing boundaries around obstacles
 *   (inner edges around pads/obstacles that were subtracted)
 */
export interface ParsedOutlineLoops {
  /**
   * CCW loops (positive signed area) - boundaries of free space.
   * These are the outer edges where components can potentially be placed.
   */
  obstacleFreeLoops: Point[][]

  /**
   * CW loops (negative signed area) - boundaries around obstacles.
   * These define the edges around pads/obstacles that were subtracted.
   */
  obstacleContainingLoops: Point[][]
}

/**
 * Calculate signed area of a polygon.
 * Positive = CCW, Negative = CW
 */
function signedArea(points: Point[]): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    const pi = points[i]!
    const pj = points[j]!
    area += pi.x * pj.y
    area -= pj.x * pi.y
  }
  return area / 2
}

/**
 * Extract points from a flatten-js face
 */
function extractFacePoints(face: any): Point[] {
  const points: Point[] = []
  let edge = face.first
  if (!edge) return points

  do {
    const shp = edge.shape
    const ps = shp.start ?? shp.ps
    points.push({ x: ps.x, y: ps.y })
    edge = edge.next
  } while (edge !== face.first)

  return points
}

/**
 * Parse a flatten-js polygon into semantically named outline loops.
 *
 * This function extracts all faces from the polygon and classifies them
 * based on their orientation (determined by signed area):
 *
 * - CCW (positive area) → obstacleFreeLoops
 * - CW (negative area) → obstacleContainingLoops
 *
 * @param polygon - A flatten-js Polygon (result of boolean operations)
 * @returns ParsedOutlineLoops with classified loops
 */
export function parseFlattenPolygonLoops(
  polygon: Flatten.Polygon,
): ParsedOutlineLoops {
  const obstacleFreeLoops: Point[][] = []
  const obstacleContainingLoops: Point[][] = []

  const faces = Array.from((polygon as any).faces) as any[]

  for (const face of faces) {
    const points = extractFacePoints(face)
    if (points.length < 3) continue // Skip degenerate faces

    const area = signedArea(points)

    if (area > 0) {
      // CCW - outer boundary / free space edge
      obstacleFreeLoops.push(points)
    } else if (area < 0) {
      // CW - inner boundary / obstacle edge
      obstacleContainingLoops.push(points)
    }
    // Skip zero-area faces (degenerate)
  }

  return {
    obstacleFreeLoops,
    obstacleContainingLoops,
  }
}

/**
 * Segment-based outline loops (compatible with existing codebase)
 */
export interface ParsedOutlineSegments {
  /**
   * CCW loops (positive signed area) - boundaries of free space.
   * Each loop is an array of segments [Point, Point].
   */
  obstacleFreeLoops: Array<[Point, Point]>[]

  /**
   * CW loops (negative signed area) - boundaries around obstacles.
   * Each loop is an array of segments [Point, Point].
   */
  obstacleContainingLoops: Array<[Point, Point]>[]
}

/**
 * Convert a points array to segments array
 */
function pointsToSegments(points: Point[]): Array<[Point, Point]> {
  const segments: Array<[Point, Point]> = []
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i]!
    const p2 = points[(i + 1) % points.length]!
    segments.push([p1, p2])
  }
  return segments
}

/**
 * Parse a flatten-js polygon into semantically named outline loops as segments.
 *
 * This is similar to parseFlattenPolygonLoops but returns segments instead of points,
 * which is compatible with the existing outline format in the codebase.
 *
 * @param polygon - A flatten-js Polygon (result of boolean operations)
 * @returns ParsedOutlineSegments with classified loops as segments
 */
export function parseFlattenPolygonSegments(
  polygon: Flatten.Polygon,
): ParsedOutlineSegments {
  const loops = parseFlattenPolygonLoops(polygon)

  return {
    obstacleFreeLoops: loops.obstacleFreeLoops.map(pointsToSegments),
    obstacleContainingLoops:
      loops.obstacleContainingLoops.map(pointsToSegments),
  }
}

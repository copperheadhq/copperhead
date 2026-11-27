// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/constructOutlinesFromPackedComponents.ts
import Flatten from "@flatten-js/core"
import type { Point } from "./local/math-utils.js"
import { combineBounds } from "./geometry/combineBounds.js"
import { getComponentBounds } from "./geometry/getComponentBounds.js"
import { simplifyCollinearSegments } from "./geometry/simplify-collinear-segments.js"
import { rotatePoint } from "./math/rotatePoint.js"
import { parseFlattenPolygonSegments } from "./parseFlattenPolygonLoops.js"
import type {
  ComponentCourtyard,
  InputObstacle,
  PackedComponent,
} from "./types.js"

type Outline = Array<[Point, Point]>

/**
 * Result of constructing outlines with semantic loop types.
 *
 * - obstacleFreeLoops: CCW loops representing the outer boundary of free space
 * - obstacleContainingLoops: CW loops representing boundaries around obstacles
 */
export interface ConstructedOutlines {
  /**
   * CCW loops (positive signed area) - the outer boundary of free space.
   * For component placement, these represent the edges of the packing area.
   */
  obstacleFreeLoops: Outline[]

  /**
   * CW loops (negative signed area) - boundaries around obstacles/pads.
   * Components should be placed outside these boundaries.
   */
  obstacleContainingLoops: Outline[]
}

/**
 * Create a single polygon from a courtyard (inflated by minGap),
 * positioned and rotated according to the component's placement.
 */
const createCourtyardPolygon = (opts: {
  component: PackedComponent
  courtyard: ComponentCourtyard
  minGap: number
}): PadShape => {
  const { component, courtyard, minGap } = opts
  const hw = courtyard.width / 2 + minGap
  const hh = courtyard.height / 2 + minGap

  const localCorners = [
    {
      x: courtyard.offsetFromCenter.x - hw,
      y: courtyard.offsetFromCenter.y - hh,
    },
    {
      x: courtyard.offsetFromCenter.x + hw,
      y: courtyard.offsetFromCenter.y - hh,
    },
    {
      x: courtyard.offsetFromCenter.x + hw,
      y: courtyard.offsetFromCenter.y + hh,
    },
    {
      x: courtyard.offsetFromCenter.x - hw,
      y: courtyard.offsetFromCenter.y + hh,
    },
  ]

  const worldCorners = localCorners.map((corner) => {
    const rotated = rotatePoint(
      corner,
      (component.ccwRotationOffset * Math.PI) / 180,
    )
    return {
      x: rotated.x + component.center.x,
      y: rotated.y + component.center.y,
    }
  })

  const arr = worldCorners.map(({ x, y }) => [x, y] as [number, number])
  const poly = new Flatten.Polygon(arr)

  const xs = worldCorners.map((p) => p.x)
  const ys = worldCorners.map((p) => p.y)
  const bbox = {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }

  return { poly, bbox }
}

/**
 * Create polygons from pads (inflated by minGap) along with their AABB in world coords
 */
type PadShape = {
  poly: Flatten.Polygon
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
}
const createPadPolygons = (
  component: PackedComponent,
  minGap: number,
): PadShape[] => {
  return component.pads.map((pad) => {
    const hw = pad.size.x / 2 + minGap
    const hh = pad.size.y / 2 + minGap

    const localCorners = [
      { x: pad.offset.x - hw, y: pad.offset.y - hh },
      { x: pad.offset.x + hw, y: pad.offset.y - hh },
      { x: pad.offset.x + hw, y: pad.offset.y + hh },
      { x: pad.offset.x - hw, y: pad.offset.y + hh },
    ]

    const worldCorners = localCorners.map((corner) => {
      const rotated = rotatePoint(
        corner,
        (component.ccwRotationOffset * Math.PI) / 180,
      )
      return {
        x: rotated.x + component.center.x,
        y: rotated.y + component.center.y,
      }
    })

    const arr = worldCorners.map(({ x, y }) => [x, y] as [number, number])
    const poly = new Flatten.Polygon(arr)

    const xs = worldCorners.map((p) => p.x)
    const ys = worldCorners.map((p) => p.y)
    const bbox = {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    }

    return { poly, bbox }
  })
}

const createObstaclePolygons = (
  obstacles: InputObstacle[],
  minGap: number,
): PadShape[] => {
  return obstacles.map((obs) => {
    const hw = obs.width / 2 + minGap
    const hh = obs.height / 2 + minGap
    const cx = obs.absoluteCenter.x
    const cy = obs.absoluteCenter.y

    const worldCorners = [
      { x: cx - hw, y: cy - hh },
      { x: cx + hw, y: cy - hh },
      { x: cx + hw, y: cy + hh },
      { x: cx - hw, y: cy + hh },
    ]

    const arr = worldCorners.map(({ x, y }) => [x, y] as [number, number])
    const poly = new Flatten.Polygon(arr)

    const xs = worldCorners.map((p) => p.x)
    const ys = worldCorners.map((p) => p.y)
    const bbox = {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    }

    return { poly, bbox }
  })
}

/**
 * Construct a set of outlines from a list of packed components.
 *
 * The outline is a list of line segments that form a closed polygon. Surrounding
 * one or more PackedComponents.
 *
 * The outlines are always at least minGap away from the edge of any pad.
 *
 */
export const constructOutlinesFromPackedComponents = (
  components: PackedComponent[],
  opts: {
    minGap?: number
    obstacles?: InputObstacle[]
  } = {},
): Outline[] => {
  const { minGap = 0, obstacles = [] } = opts
  if (components.length === 0 && obstacles.length === 0) return []

  const componentBounds = components.map((c) => getComponentBounds(c, minGap))
  const obstacleBounds = obstacles.map((o) => ({
    minX: o.absoluteCenter.x - o.width / 2 - minGap,
    minY: o.absoluteCenter.y - o.height / 2 - minGap,
    maxX: o.absoluteCenter.x + o.width / 2 + minGap,
    maxY: o.absoluteCenter.y + o.height / 2 + minGap,
  }))
  const bounds = combineBounds([...componentBounds, ...obstacleBounds])

  // Build pad polygons (inflated by minGap) and obstacle polygons
  const allPadShapes: PadShape[] = []
  for (const component of components) {
    if (component.courtyard) {
      allPadShapes.push(
        createCourtyardPolygon({
          component,
          courtyard: component.courtyard,
          minGap,
        }),
      )
    } else {
      const padShapes = createPadPolygons(component, minGap)
      allPadShapes.push(...padShapes)
    }
  }
  const obstacleShapes = createObstaclePolygons(obstacles, minGap)
  allPadShapes.push(...obstacleShapes)
  if (allPadShapes.length === 0) return []

  // Drop degenerate and fully-contained shapes
  const filteredPadShapes = filterPadShapes(allPadShapes)
  const keptPadPolys = filteredPadShapes.map((s) => s.poly)

  // Create bounding box
  let A = new Flatten.Polygon(
    new Flatten.Box(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY),
  )
  const B = A.clone()

  // Subtract pads from A to get free space
  for (const poly of keptPadPolys) {
    try {
      A = Flatten.BooleanOperations.subtract(A, poly)
    } catch {
      // Ignore individual subtract errors
    }
  }

  // Compute B - A to get the obstacles (union of pads)
  let union: Flatten.Polygon | null = null
  try {
    union = Flatten.BooleanOperations.subtract(B, A)
  } catch {
    // Fall back to a direct union of pad polygons if subtract fails
    try {
      if (keptPadPolys.length > 0) {
        let U = keptPadPolys[0]!
        for (let i = 1; i < keptPadPolys.length; i++) {
          try {
            U = Flatten.BooleanOperations.unify(U, keptPadPolys[i]!)
          } catch {
            // Skip problematic union
          }
        }
        union = U
      }
    } catch {
      union = null
    }
  }

  if (!union) return []

  // Parse the obstacles polygon (B - A) to get all outlines
  const parsed = parseFlattenPolygonSegments(union)

  // Return ALL loops from the union polygon:
  // - obstacleFreeLoops (CCW): outer boundaries of obstacle islands
  // - obstacleContainingLoops (CW): inner holes within obstacle groups (free space pockets)
  //
  // The old code used `if (face.isHole) continue` but face.isHole is always undefined,
  // so it was actually returning ALL faces. We need to do the same for backward compatibility.
  //
  // IMPORTANT: We keep the ORIGINAL winding directions (CCW for outer, CW for holes).
  // This is critical because:
  // 1. getOutwardNormal() uses signed area to determine which direction is "outward"
  // 2. For CCW (outer boundaries): outward points AWAY from obstacles into free space
  // 3. For CW (holes/free space pockets): outward points INTO the hole (the free space)
  // 4. If we reversed CW to CCW, the outward normal would flip to point into obstacle material
  //
  // The LargestRectOutsideOutlineFromPointSolver and other consumers need to understand
  // both winding directions to correctly place components.
  const allOutlines: Outline[] = [
    ...parsed.obstacleFreeLoops.map((outline) =>
      simplifyCollinearSegments(outline),
    ),
    ...parsed.obstacleContainingLoops.map((outline) =>
      simplifyCollinearSegments(outline),
    ),
  ]

  // Filter out degenerate outlines (less than 3 segments can't form a closed polygon)
  return allOutlines.filter((outline) => outline.length >= 3)
}

/**
 * Construct semantic outlines from a list of packed components.
 *
 * Returns both types of outline loops:
 * - obstacleFreeLoops: CCW loops representing the outer boundary of free space
 * - obstacleContainingLoops: CW loops representing boundaries around obstacles
 *
 * The outlines are always at least minGap away from the edge of any pad.
 */
export const constructSemanticOutlinesFromPackedComponents = (
  components: PackedComponent[],
  opts: {
    minGap?: number
    obstacles?: InputObstacle[]
  } = {},
): ConstructedOutlines => {
  const { minGap = 0, obstacles = [] } = opts
  if (components.length === 0 && obstacles.length === 0) {
    return { obstacleFreeLoops: [], obstacleContainingLoops: [] }
  }

  const componentBounds = components.map((c) => getComponentBounds(c, minGap))
  const obstacleBounds = obstacles.map((o) => ({
    minX: o.absoluteCenter.x - o.width / 2 - minGap,
    minY: o.absoluteCenter.y - o.height / 2 - minGap,
    maxX: o.absoluteCenter.x + o.width / 2 + minGap,
    maxY: o.absoluteCenter.y + o.height / 2 + minGap,
  }))
  const bounds = combineBounds([...componentBounds, ...obstacleBounds])

  // Build pad polygons (inflated by minGap) and obstacle polygons
  const allPadShapes: PadShape[] = []
  for (const component of components) {
    if (component.courtyard) {
      allPadShapes.push(
        createCourtyardPolygon({
          component,
          courtyard: component.courtyard,
          minGap,
        }),
      )
    } else {
      const padShapes = createPadPolygons(component, minGap)
      allPadShapes.push(...padShapes)
    }
  }
  const obstacleShapes = createObstaclePolygons(obstacles, minGap)
  allPadShapes.push(...obstacleShapes)

  if (allPadShapes.length === 0) {
    return { obstacleFreeLoops: [], obstacleContainingLoops: [] }
  }

  // Drop degenerate and fully-contained shapes
  const filteredPadShapes = filterPadShapes(allPadShapes)
  const keptPadPolys = filteredPadShapes.map((s) => s.poly)

  // Create bounding box and subtract obstacles to get free space
  let freeSpace = new Flatten.Polygon(
    new Flatten.Box(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY),
  )

  for (const poly of keptPadPolys) {
    try {
      freeSpace = Flatten.BooleanOperations.subtract(freeSpace, poly)
    } catch {
      // Ignore individual subtract errors
    }
  }

  // Parse free space into semantic loop types
  const parsed = parseFlattenPolygonSegments(freeSpace)

  // Filter out degenerate outlines (less than 3 segments can't form a closed polygon)
  const filterDegenerate = (outline: Outline) => outline.length >= 3

  return {
    obstacleFreeLoops: parsed.obstacleFreeLoops
      .map((outline) => simplifyCollinearSegments(outline))
      .filter(filterDegenerate),
    obstacleContainingLoops: parsed.obstacleContainingLoops
      .map((outline) => simplifyCollinearSegments(outline))
      .filter(filterDegenerate),
  }
}

/**
 * Filter pad shapes to remove degenerate and fully-contained ones
 */
function filterPadShapes(allPadShapes: PadShape[]): PadShape[] {
  const areaOfBox = (b: {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }) => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)

  const containsBox = (
    outer: { minX: number; minY: number; maxX: number; maxY: number },
    inner: { minX: number; minY: number; maxX: number; maxY: number },
    eps = 1e-9,
  ) =>
    outer.minX - eps <= inner.minX &&
    outer.minY - eps <= inner.minY &&
    outer.maxX + eps >= inner.maxX &&
    outer.maxY + eps >= inner.maxY

  const sortedByAreaDesc = [...allPadShapes].sort(
    (a, b) => areaOfBox(b.bbox) - areaOfBox(a.bbox),
  )

  const filtered: PadShape[] = []
  for (const shape of sortedByAreaDesc) {
    const w = shape.bbox.maxX - shape.bbox.minX
    const h = shape.bbox.maxY - shape.bbox.minY
    if (!(w > 1e-12 && h > 1e-12)) continue // skip degenerate

    let contained = false
    for (const kept of filtered) {
      if (containsBox(kept.bbox, shape.bbox)) {
        contained = true
        break
      }
    }
    if (!contained) filtered.push(shape)
  }

  return filtered
}

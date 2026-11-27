// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/geometry/pointInOutline.ts
type Point = { x: number; y: number }
type Segment = [Point, Point]

type Location = "outside" | "inside" | "boundary"
type Rule = "even-odd" | "nonzero"

const EPS = 1e-9

function almostEqual(a: number, b: number, eps = EPS) {
  return Math.abs(a - b) <= eps
}

function cross(ax: number, ay: number, bx: number, by: number) {
  return ax * by - ay * bx
}

function isLeft(a: Point, b: Point, p: Point): number {
  // >0 if p is left of ab, <0 if right, 0 if collinear
  return cross(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y)
}

function pointOnSegment(p: Point, a: Point, b: Point, eps = EPS): boolean {
  // collinear and within bounding box
  const area2 = isLeft(a, b, p)
  if (Math.abs(area2) > eps) return false
  const minx = Math.min(a.x, b.x) - eps
  const maxx = Math.max(a.x, b.x) + eps
  const miny = Math.min(a.y, b.y) - eps
  const maxy = Math.max(a.y, b.y) + eps
  return p.x >= minx && p.x <= maxx && p.y >= miny && p.y <= maxy
}

export function pointInOutline(
  p: Point,
  segments: Segment[], // closed outline (last connects back to first) not strictly required
  rule: Rule = "even-odd",
): Location {
  // quick reject by overall bbox (optional but fast)
  let minx = Infinity
  let miny = Infinity
  let maxx = -Infinity
  let maxy = -Infinity
  for (const s of segments) {
    const [a, b] = s
    minx = Math.min(minx, a.x, b.x)
    miny = Math.min(miny, a.y, b.y)
    maxx = Math.max(maxx, a.x, b.x)
    maxy = Math.max(maxy, a.y, b.y)
  }
  if (
    p.x < minx - EPS ||
    p.x > maxx + EPS ||
    p.y < miny - EPS ||
    p.y > maxy + EPS
  ) {
    return "outside"
  }

  // boundary check
  for (const s of segments) {
    const [a, b] = s
    if (pointOnSegment(p, a, b)) return "boundary"
  }

  if (rule === "even-odd") {
    // ray cast to +x; count crossings, using [miny, maxy) to avoid double-counting tops
    let crossings = 0
    for (const s of segments) {
      const [a, b] = s
      const ay = a.y
      const by = b.y
      const ax = a.x
      const bx = b.x

      // check if segment straddles horizontal line y = p.y (including lower endpoint, excluding upper)
      const cond = (ay <= p.y && p.y < by) || (by <= p.y && p.y < ay)
      if (!cond) continue

      const dy = by - ay
      if (Math.abs(dy) < EPS) continue // horizontal segment: ignore in crossing count

      const t = (p.y - ay) / dy // 0..1 where it hits
      const xAtY = ax + t * (bx - ax)

      if (xAtY > p.x + EPS) crossings++
    }
    return crossings % 2 === 1 ? "inside" : "outside"
  } else {
    // non-zero winding rule
    let winding = 0
    for (const s of segments) {
      const [a, b] = s
      if (a.y <= p.y) {
        if (b.y > p.y && isLeft(a, b, p) > EPS) winding++ // upward crossing, point left of edge
      } else {
        if (b.y <= p.y && isLeft(a, b, p) < -EPS) winding-- // downward crossing, point right of edge
      }
    }
    return winding !== 0 ? "inside" : "outside"
  }
}

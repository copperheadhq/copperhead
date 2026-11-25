// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/math/computeNearestPointOnSegmentForSegmentSet.ts
type Point = { x: number; y: number }
type Segment = [Point, Point]

/* ---------- small vector helpers ---------- */
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s })
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y
const clamp = (v: number, lo = 0, hi = 1): number =>
  Math.max(lo, Math.min(hi, v))

/* ---------- closest-points between two segments ---------- */
function closestPointOnSegAToSegB(
  segA: Segment,
  segB: Segment,
): { pointA: Point; paramA: number; dist2: number } {
  const [p, q] = segA // A(s) = p + s·u, 0≤s≤1
  const [r, s] = segB // B(t) = r + t·v, 0≤t≤1
  const u = sub(q, p)
  const v = sub(s, r)
  const w0 = sub(p, r)

  const a = dot(u, u)
  const b = dot(u, v)
  const c = dot(v, v)
  const d = dot(u, w0)
  const e = dot(v, w0)
  const EPS = 1e-12

  const D = a * c - b * b // denominator
  let sN: number
  let tN: number
  let sD = D
  let tD = D

  // Parallel? – fall back to endpoint projection
  if (D < EPS) {
    sN = 0
    sD = 1
    tN = e
    tD = c
  } else {
    sN = b * e - c * d
    tN = a * e - b * d

    if (sN < 0) {
      // clamp s = 0
      sN = 0
      tN = e
      tD = c
    } else if (sN > sD) {
      // clamp s = 1
      sN = sD
      tN = e + b
      tD = c
    }
  }

  // clamp t to [0,1] (may move s again)
  if (tN < 0) {
    tN = 0
    sN = clamp(-d, 0, a)
    sD = a
  } else if (tN > tD) {
    tN = tD
    sN = clamp(-d + b, 0, a)
    sD = a
  }

  const sParam = sD > EPS ? sN / sD : 0
  const closestA = add(p, mul(u, sParam))

  // distance²
  const tParam = tD > EPS ? tN / tD : 0
  const closestB = add(r, mul(v, tParam))
  const diff = sub(closestA, closestB)

  return { pointA: closestA, paramA: sParam, dist2: dot(diff, diff) }
}

/* ---------- public API ---------- */
export function computeNearestPointOnSegmentForSegmentSet(
  segmentA: Segment,
  segmentSet: Segment[],
): { nearestPoint: Point; dist: number } {
  if (!segmentSet.length)
    throw new Error("segmentSet must contain at least one segment")

  let bestPoint: Point = segmentA[0]
  let bestDist2 = Number.POSITIVE_INFINITY

  for (const segB of segmentSet) {
    const { pointA, dist2 } = closestPointOnSegAToSegB(segmentA, segB)

    if (dist2 < bestDist2) {
      bestDist2 = dist2
      bestPoint = pointA
      if (bestDist2 === 0) break // early-out: segments touch
    }
  }

  return { nearestPoint: bestPoint, dist: Math.sqrt(bestDist2) }
}

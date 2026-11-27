/**
 * Geometry facade for the PCB IR (ADR 0005). Every polygon operation the
 * framework needs goes through this module; it is the only file that imports
 * the kernel (`polygon-clipping`, MIT, Martinez-Rueda with snap rounding), so
 * the kernel can be swapped without touching callers.
 *
 * Coordinates are integer nanometres in KiCad's frame: X right, Y down,
 * positive rotation counter-clockwise on screen. All polygons are simple
 * rings with optional holes; orientation is normalised on construction.
 */
import pc from 'polygon-clipping';
import type { Nm, Mdeg } from './units.js';

export interface Point {
  x: Nm;
  y: Nm;
}

/** A polygon: one outer ring plus holes. Rings are closed implicitly (last != first). */
export interface Polygon {
  outer: Point[];
  holes: Point[][];
}

export interface BBox {
  minX: Nm;
  minY: Nm;
  maxX: Nm;
  maxY: Nm;
}

type Pair = [number, number];
type Ring = Pair[];
type PcPolygon = Ring[];
type PcMulti = PcPolygon[];

const CIRCLE_SEGMENTS = 32;

/** Negative zero to zero, so canonical JSON and deep-equals never see -0. */
const nz = (n: number): number => (n === 0 ? 0 : n);

// ---------------------------------------------------------------- transforms

export function translate(poly: Polygon, dx: Nm, dy: Nm): Polygon {
  const t = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  return { outer: poly.outer.map(t), holes: poly.holes.map((h) => h.map(t)) };
}

/**
 * Rotate about the origin by `mdeg` in KiCad's Y-down frame, where a positive
 * angle turns counter-clockwise on screen: x' = x·cos + y·sin, y' = −x·sin + y·cos
 * (verified against pcbnew pad positions on the StickHub demo, RFC 11 §6).
 */
export function rotatePoint(p: Point, mdeg: Mdeg): Point {
  if (mdeg === 0) return p;
  const a = (mdeg / 1000) * (Math.PI / 180);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: nz(Math.round(p.x * c + p.y * s)), y: nz(Math.round(-p.x * s + p.y * c)) };
}

export function rotate(poly: Polygon, mdeg: Mdeg): Polygon {
  if (mdeg === 0) return poly;
  return { outer: poly.outer.map((p) => rotatePoint(p, mdeg)), holes: poly.holes.map((h) => h.map((p) => rotatePoint(p, mdeg))) };
}

/** Place a footprint-local polygon on the board: rotate about the footprint origin, then translate. */
export function placeLocal(poly: Polygon, origin: Point, mdeg: Mdeg): Polygon {
  return translate(rotate(poly, mdeg), origin.x, origin.y);
}

// ---------------------------------------------------------------- primitives

export function rect(cx: Nm, cy: Nm, w: Nm, h: Nm): Polygon {
  const hw = w / 2;
  const hh = h / 2;
  return {
    outer: [
      { x: Math.round(cx - hw), y: Math.round(cy - hh) },
      { x: Math.round(cx + hw), y: Math.round(cy - hh) },
      { x: Math.round(cx + hw), y: Math.round(cy + hh) },
      { x: Math.round(cx - hw), y: Math.round(cy + hh) },
    ],
    holes: [],
  };
}

export function rectFromBounds(minX: Nm, minY: Nm, maxX: Nm, maxY: Nm): Polygon {
  return { outer: [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }], holes: [] };
}

export function circle(cx: Nm, cy: Nm, d: Nm, segments = CIRCLE_SEGMENTS): Polygon {
  const r = d / 2;
  const outer: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    outer.push({ x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)) });
  }
  return { outer, holes: [] };
}

/** An oval pad: a stadium whose long axis follows the larger dimension. */
export function stadium(cx: Nm, cy: Nm, w: Nm, h: Nm): Polygon {
  if (w === h) return circle(cx, cy, w);
  const horizontal = w > h;
  const r = (horizontal ? h : w) / 2;
  const half = (horizontal ? w : h) / 2 - r; // distance from centre to each arc centre
  const outer: Point[] = [];
  const n = CIRCLE_SEGMENTS / 2;
  // right/bottom arc then left/top arc
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI;
    const px = horizontal ? half + r * Math.cos(a) : r * Math.cos(a + Math.PI / 2) ;
    const py = horizontal ? r * Math.sin(a) : half + r * Math.sin(a + Math.PI / 2);
    outer.push({ x: Math.round(cx + px), y: Math.round(cy + py) });
  }
  for (let i = 0; i <= n; i++) {
    const a = Math.PI / 2 + (i / n) * Math.PI;
    const px = horizontal ? -half + r * Math.cos(a) : r * Math.cos(a + Math.PI / 2);
    const py = horizontal ? r * Math.sin(a) : -half + r * Math.sin(a + Math.PI / 2);
    outer.push({ x: Math.round(cx + px), y: Math.round(cy + py) });
  }
  return { outer: dedupe(outer), holes: [] };
}

/** A rounded rectangle; `radius` is the corner radius (KiCad: rratio × min(w, h)). */
export function roundRect(cx: Nm, cy: Nm, w: Nm, h: Nm, radius: Nm): Polygon {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r === 0) return rect(cx, cy, w, h);
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const outer: Point[] = [];
  const n = 8; // segments per corner
  const corners: [number, number, number][] = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, (3 * Math.PI) / 2],
  ];
  for (const [ox, oy, start] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = start + (i / n) * (Math.PI / 2);
      outer.push({ x: Math.round(cx + ox + r * Math.cos(a)), y: Math.round(cy + oy + r * Math.sin(a)) });
    }
  }
  return { outer: dedupe(outer), holes: [] };
}

function dedupe(ring: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && first.x === last.x && first.y === last.y) out.pop();
  return out;
}

// ---------------------------------------------------------------- kernel bridge

function toPc(poly: Polygon): PcPolygon {
  const ring = (r: Point[]): Ring => {
    const out: Ring = r.map((p) => [p.x, p.y]);
    const f = out[0];
    if (f) out.push([f[0], f[1]]);
    return out;
  };
  return [ring(poly.outer), ...poly.holes.map(ring)];
}

function fromPc(multi: PcMulti): Polygon[] {
  return multi.map((poly) => {
    const rings = poly.map((r) => {
      // the kernel returns fractional intersection vertices; the IR is integer nanometres
      const pts = r.map(([x, y]) => ({ x: nz(Math.round(x)), y: nz(Math.round(y)) }));
      const f = pts[0];
      const l = pts[pts.length - 1];
      if (pts.length > 1 && f && l && f.x === l.x && f.y === l.y) pts.pop();
      return pts;
    });
    return { outer: rings[0] ?? [], holes: rings.slice(1) };
  });
}

// ---------------------------------------------------------------- operations

export function union(polys: Polygon[]): Polygon[] {
  if (!polys.length) return [];
  const [first, ...rest] = polys as [Polygon, ...Polygon[]];
  return fromPc(pc.union(toPc(first), ...rest.map(toPc)));
}

export function intersection(a: Polygon, b: Polygon): Polygon[] {
  return fromPc(pc.intersection(toPc(a), toPc(b)));
}

/** True when the two polygons share any interior area (touching edges do not count). */
export function intersects(a: Polygon, b: Polygon): boolean {
  if (!bboxOverlap(bbox(a), bbox(b))) return false;
  return intersection(a, b).some((p) => area(p) > 0);
}

/** Signed shoelace area of the outer ring minus holes, in nm². */
export function area(poly: Polygon): number {
  const ringArea = (r: Point[]): number => {
    let s = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i]!;
      const q = r[(i + 1) % r.length]!;
      s += p.x * q.y - q.x * p.y;
    }
    return Math.abs(s) / 2;
  };
  return ringArea(poly.outer) - poly.holes.reduce((s, h) => s + ringArea(h), 0);
}

export function bbox(poly: Polygon): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly.outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxOf(polys: Polygon[]): BBox {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of polys) {
    const q = bbox(p);
    b.minX = Math.min(b.minX, q.minX);
    b.minY = Math.min(b.minY, q.minY);
    b.maxX = Math.max(b.maxX, q.maxX);
    b.maxY = Math.max(b.maxY, q.maxY);
  }
  return b;
}

export function bboxOverlap(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

export function centroid(poly: Polygon): Point {
  // area-weighted centroid of the outer ring (holes ignored: good enough for placement metrics)
  const r = poly.outer;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q = r[(i + 1) % r.length]!;
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (a === 0) {
    const b = bbox(poly);
    return { x: Math.round((b.minX + b.maxX) / 2), y: Math.round((b.minY + b.maxY) / 2) };
  }
  return { x: Math.round(cx / (3 * a)), y: Math.round(cy / (3 * a)) };
}

/** Ray-casting point-in-polygon (holes respected). Boundary points count as inside. */
export function contains(poly: Polygon, p: Point): boolean {
  const inRing = (r: Point[]): boolean => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i]!;
      const b = r[j]!;
      if (onSegment(p, a, b)) return true;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  if (!inRing(poly.outer)) return false;
  return !poly.holes.some((h) => inRing(h) && !h.some((q) => onSegment(p, q, q)));
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 1e-6 * Math.max(1, Math.abs(b.x - a.x) + Math.abs(b.y - a.y))) return false;
  return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segSegDist(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

function rings(poly: Polygon): Point[][] {
  return [poly.outer, ...poly.holes];
}

/** Minimum edge-to-edge distance between two polygons; 0 when they overlap or touch. */
export function distance(a: Polygon, b: Polygon): number {
  if (intersects(a, b)) return 0;
  const fa = a.outer[0];
  const fb = b.outer[0];
  if (fa && contains(b, fa)) return 0;
  if (fb && contains(a, fb)) return 0;
  let best = Infinity;
  for (const ra of rings(a)) {
    for (let i = 0; i < ra.length; i++) {
      const a1 = ra[i]!;
      const a2 = ra[(i + 1) % ra.length]!;
      for (const rb of rings(b)) {
        for (let j = 0; j < rb.length; j++) {
          const b1 = rb[j]!;
          const b2 = rb[(j + 1) % rb.length]!;
          const d = segSegDist(a1, a2, b1, b2);
          if (d < best) best = d;
          if (best === 0) return 0;
        }
      }
    }
  }
  return best;
}

/** Distance from a point to the nearest edge (0 inside). */
export function distanceToPoint(poly: Polygon, p: Point): number {
  if (contains(poly, p)) return 0;
  let best = Infinity;
  for (const r of rings(poly)) {
    for (let i = 0; i < r.length; i++) best = Math.min(best, segDist(p, r[i]!, r[(i + 1) % r.length]!));
  }
  return best;
}

/**
 * Grow (positive) or shrink (negative) a polygon by `d`. Growth is the union
 * of the polygon with a capsule around every edge; shrinking is the outer
 * boundary minus that same band. Exact for the clearance and edge-inset uses
 * the framework has; not a general offset kernel.
 */
export function offset(poly: Polygon, d: Nm): Polygon[] {
  if (d === 0) return [poly];
  const band: Polygon[] = [];
  for (const r of rings(poly)) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      band.push(capsule(a, b, Math.abs(d) * 2));
    }
  }
  if (d > 0) return union([poly, ...band]);
  const grown = union(band);
  let result: PcMulti = [toPc(poly)];
  for (const g of grown) result = pc.difference(result, toPc(g));
  return fromPc(result);
}

/** A stroked segment: the stadium of width `w` along a–b (a track's copper). */
export function capsule(a: Point, b: Point, w: Nm): Polygon {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return circle(a.x, a.y, w);
  const ang = Math.atan2(dy, dx);
  // stadium along +x of length len centred at the midpoint, then rotate by -ang (Y-down frame) and translate
  const s = stadium(0, 0, Math.round(len + w), w);
  const mdeg = -Math.round((ang * 180) / Math.PI * 1000);
  return translate(rotate(s, mdeg), Math.round((a.x + b.x) / 2), Math.round((a.y + b.y) / 2));
}

/** Chain open segments (start/end pairs) into closed loops with a join tolerance. */
export function chainLoops(segments: { a: Point; b: Point }[], tolNm: Nm): { loops: Point[][]; open: number } {
  const remaining = segments.map((s) => ({ a: s.a, b: s.b }));
  const loops: Point[][] = [];
  let open = 0;
  const near = (p: Point, q: Point) => Math.abs(p.x - q.x) <= tolNm && Math.abs(p.y - q.y) <= tolNm;
  while (remaining.length) {
    const first = remaining.shift()!;
    const loop: Point[] = [first.a, first.b];
    let closed = false;
    for (;;) {
      const tail = loop[loop.length - 1]!;
      if (loop.length > 2 && near(tail, loop[0]!)) {
        loop.pop();
        closed = true;
        break;
      }
      // nearest endpoint wins: with discretized arcs, neighbours can sit within
      // the tolerance of each other and first-match would skip vertices
      let idx = -1;
      let best = Infinity;
      let fromA = true;
      for (let k = 0; k < remaining.length; k++) {
        const s = remaining[k]!;
        const da = Math.hypot(s.a.x - tail.x, s.a.y - tail.y);
        const db = Math.hypot(s.b.x - tail.x, s.b.y - tail.y);
        if (near(s.a, tail) && da < best) {
          best = da;
          idx = k;
          fromA = true;
        }
        if (near(s.b, tail) && db < best) {
          best = db;
          idx = k;
          fromA = false;
        }
      }
      if (idx < 0) break;
      const s = remaining.splice(idx, 1)[0]!;
      loop.push(fromA ? s.b : s.a);
    }
    if (closed) loops.push(loop);
    else open++;
  }
  return { loops, open };
}

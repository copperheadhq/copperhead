import { child, children, isList, parseSexp, type SexpNode } from './sexp.js';

/**
 * Universal placement checks: deterministic, contract-free rules that hold for
 * any board, measured on the board text alone.
 *
 * Errors are hard placement defects that no correct board has. Warnings are
 * thresholded heuristics (decoupling distance, crystal distance, utilization)
 * that a reviewer should look at but a good board may legitimately exceed.
 * Routing state is never judged here: an unrouted board can pass.
 *
 * Coordinates follow KiCad: a footprint child's board position is
 * origin + R(rot)·local with screen Y down, and a flipped footprint's children
 * are already stored mirrored, so back-side parts need no extra mirror.
 */

export type PlacementCheckId =
  | 'pad-overlap'
  | 'courtyard-overlap'
  | 'silkscreen-overlap'
  | 'tht-underside'
  | 'outline-containment'
  | 'footprint-keepout'
  | 'edge-connector'
  | 'courtyard-overhang'
  | 'antenna-edge'
  | 'decoupling-distance'
  | 'crystal-distance'
  | 'utilization';

export interface PlacementFinding {
  id: PlacementCheckId;
  severity: 'error' | 'warning';
  refs: string[];
  detail: string;
}
export interface CopperCounts {
  segments: number;
  arcs: number;
  vias: number;
  zones: number;
}

export interface DecouplingMeasurement {
  ref: string;
  rail: string;
  ic: string | null;
  distanceMm: number | null;
  bulk: boolean;
}

export interface CrystalMeasurement {
  ref: string;
  ic: string | null;
  distancesMm: number[];
}

export interface PlacementCheckReport {
  ok: boolean;
  errors: PlacementFinding[];
  warnings: PlacementFinding[];
  metrics: {
    components: number;
    outline: { widthMm: number; heightMm: number; areaMm2: number; loops: number } | null;
    courtyardAreaMm2: number;
    utilization: number | null;
    hpwlMm: number;
    copper: CopperCounts;
    decoupling: DecouplingMeasurement[];
    medianDecouplingMm: number | null;
    crystals: CrystalMeasurement[];
  };
}

interface P {
  x: number;
  y: number;
}

interface Pad {
  number: string;
  kind: string;
  shape: string;
  local: P;
  /** Library-local angle (absolute pad angle minus the footprint angle), degrees. */
  localAngle: number;
  size: P;
  net: string;
  pintype: string;
  layers: string[];
  center: P;
  polygon: P[];
}

interface Keepout {
  name: string;
  layers: string[];
  polygon: P[];
  footprintsBlocked: boolean;
  copperBlocked: boolean;
}

interface Part {
  ref: string;
  footprint: string;
  value: string;
  side: 'F' | 'B';
  origin: P;
  rotation: number;
  boardOnly: boolean;
  netTie: boolean;
  tht: boolean;
  pads: Pad[];
  /** Board-coordinate courtyard loops, or the pads' bounding quad when there is no courtyard. */
  body: P[][];
  /** Conservative per-item board-coordinate envelopes on this part's silkscreen side. */
  silk: P[][];
  hasCourtyard: boolean;
  bodyAreaMm2: number;
  keepouts: Keepout[];
}

const EPS = 0.005;
const atom = (node: SexpNode[] | undefined, idx: number): string | undefined => {
  const value = node?.[idx];
  return typeof value === 'string' ? value : undefined;
};
const num = (value: string | undefined, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const pointOf = (node: SexpNode[] | undefined): P | null => {
  if (!node) return null;
  const x = Number(atom(node, 1));
  const y = Number(atom(node, 2));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
};
const collator = new Intl.Collator('en', { numeric: true });
const byRef = (a: string, b: string): number => collator.compare(a, b);
const round = (value: number, digits = 3): number => Math.round(value * 10 ** digits) / 10 ** digits;
const mod = (value: number, by: number): number => ((value % by) + by) % by;

/** KiCad footprint-local point to board coordinates. */
function place(local: P, origin: P, degrees: number): P {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: origin.x + local.x * c + local.y * s, y: origin.y - local.x * s + local.y * c };
}

function quad(min: P, max: P, origin: P, degrees: number): P[] {
  return [
    place({ x: min.x, y: min.y }, origin, degrees),
    place({ x: max.x, y: min.y }, origin, degrees),
    place({ x: max.x, y: max.y }, origin, degrees),
    place({ x: min.x, y: max.y }, origin, degrees),
  ];
}

// ---------------------------------------------------------------- polygons

function polygonArea(poly: P[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function pointInPolygon(point: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentPointDistance(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const cross = (o: P, p: P, q: P): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

function edges(poly: P[]): [P, P][] {
  return poly.map((p, i) => [p, poly[(i + 1) % poly.length]!]);
}

/** Minimum distance between two polygons' boundaries (0 when they cross). */
function boundaryDistance(a: P[], b: P[]): number {
  let best = Infinity;
  for (const [p, q] of edges(a)) {
    for (const [r, s] of edges(b)) {
      if (segmentsCross(p, q, r, s)) return 0;
      best = Math.min(best, segmentPointDistance(p, r, s), segmentPointDistance(q, r, s), segmentPointDistance(r, p, q), segmentPointDistance(s, p, q));
    }
  }
  return best;
}

/** Penetration depth of two convex polygons along their separating axes (≤ 0: disjoint or touching). */
function convexPenetration(a: P[], b: P[]): number {
  let least = Infinity;
  for (const poly of [a, b]) {
    for (const [p, q] of edges(poly)) {
      const nx = -(q.y - p.y);
      const ny = q.x - p.x;
      const len = Math.hypot(nx, ny);
      if (len === 0) continue;
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const v of a) {
        const t = (v.x * nx + v.y * ny) / len;
        aMin = Math.min(aMin, t);
        aMax = Math.max(aMax, t);
      }
      for (const v of b) {
        const t = (v.x * nx + v.y * ny) / len;
        bMin = Math.min(bMin, t);
        bMax = Math.max(bMax, t);
      }
      least = Math.min(least, Math.min(aMax, bMax) - Math.max(aMin, bMin));
      if (least <= 0) return least;
    }
  }
  return least;
}

/** Signed area: positive for counter-clockwise in a Y-up frame. */
function signedArea(poly: P[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function isConvex(poly: P[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = poly[(i + 2) % poly.length]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/** Ear-clipping triangulation of a simple polygon. */
function triangulate(poly: P[]): P[][] {
  const ccw = signedArea(poly) > 0 ? [...poly] : [...poly].reverse();
  const out: P[][] = [];
  const cross = (o: P, a: P, b: P): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  let guard = ccw.length * ccw.length;
  while (ccw.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < ccw.length; i++) {
      const a = ccw[(i + ccw.length - 1) % ccw.length]!;
      const b = ccw[i]!;
      const c = ccw[(i + 1) % ccw.length]!;
      if (cross(a, b, c) <= 1e-12) continue;
      const blocked = ccw.some((p) => p !== a && p !== b && p !== c && cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0);
      if (blocked) continue;
      out.push([a, b, c]);
      ccw.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (ccw.length === 3) out.push(ccw);
  else if (ccw.length > 3) out.push(ccw); // degenerate remainder: treat as one piece
  return out;
}

/** Sutherland–Hodgman: `subject` (any simple polygon) clipped by a convex `clip`. */
function clipConvex(subject: P[], clip: P[]): P[] {
  const ccwClip = signedArea(clip) > 0 ? clip : [...clip].reverse();
  let output = subject;
  for (let i = 0; i < ccwClip.length && output.length; i++) {
    const a = ccwClip[i]!;
    const b = ccwClip[(i + 1) % ccwClip.length]!;
    const inside = (p: P): boolean => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
    const cut = (p: P, q: P): P => {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const den = (b.x - a.x) * dy - (b.y - a.y) * dx;
      const t = den === 0 ? 0 : ((b.x - a.x) * (a.y - p.y) - (b.y - a.y) * (a.x - p.x)) / den;
      return { x: p.x + t * dx, y: p.y + t * dy };
    };
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const current = input[j]!;
      const previous = input[(j + input.length - 1) % input.length]!;
      if (inside(current)) {
        if (!inside(previous)) output.push(cut(previous, current));
        output.push(current);
      } else if (inside(previous)) output.push(cut(previous, current));
    }
  }
  return output;
}

/** Area shared by two simple polygons (either may be concave). */
export function overlapArea(a: P[], b: P[]): number {
  const pieces = isConvex(b) ? [b] : triangulate(b);
  let area = 0;
  for (const piece of pieces) {
    const clipped = clipConvex(a, piece);
    if (clipped.length >= 3) area += polygonArea(clipped);
  }
  return area;
}

/** Overlap below this area (mm²) is numerical touching, not a collision. */
const MIN_OVERLAP_MM2 = 1e-4;

function polygonsIntersect(a: P[], b: P[]): boolean {
  return overlapArea(a, b) > MIN_OVERLAP_MM2;
}

function bodiesIntersect(a: P[][], b: P[][]): boolean {
  return a.some((x) => b.some((y) => boxesMayTouch(x, y) && polygonsIntersect(x, y)));
}

function boundsOf(points: P[]): { min: P; max: P } {
  return {
    min: { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) },
    max: { x: Math.max(...points.map((p) => p.x)), y: Math.max(...points.map((p) => p.y)) },
  };
}

function boxesMayTouch(a: P[], b: P[], margin = 0): boolean {
  const x = boundsOf(a);
  const y = boundsOf(b);
  return x.min.x <= y.max.x + margin && y.min.x <= x.max.x + margin && x.min.y <= y.max.y + margin && y.min.y <= x.max.y + margin;
}

// ---------------------------------------------------------------- parsing

function graphicPoints(item: SexpNode[]): P[] {
  const points: P[] = [];
  for (const key of ['start', 'mid', 'end']) {
    const point = pointOf(child(item, key));
    if (point) points.push(point);
  }
  for (const xy of children(child(item, 'pts') ?? [], 'xy')) {
    const point = pointOf(xy);
    if (point) points.push(point);
  }
  const center = pointOf(child(item, 'center'));
  if (item[0] === 'fp_circle' && center && points[0]) {
    const r = Math.hypot(points[0].x - center.x, points[0].y - center.y);
    points.push({ x: center.x - r, y: center.y - r }, { x: center.x + r, y: center.y + r });
  }
  return points;
}

function envelope(points: P[], margin = 0): P[] | null {
  if (!points.length) return null;
  const box = boundsOf(points);
  return [
    { x: box.min.x - margin, y: box.min.y - margin },
    { x: box.max.x + margin, y: box.min.y - margin },
    { x: box.max.x + margin, y: box.max.y + margin },
    { x: box.min.x - margin, y: box.max.y + margin },
  ];
}

/**
 * Cheap conservative envelopes for individual silkscreen items. Exact KiCad
 * DRC remains the final authority; these prevent the optimizer from repeatedly
 * proposing obvious text/line collisions that DRC would reject later.
 */
function silkEnvelopes(fp: SexpNode[], origin: P, rotation: number, side: 'F' | 'B'): P[][] {
  const out: P[][] = [];
  for (const item of fp) {
    if (!isList(item) || typeof item[0] !== 'string') continue;
    if (atom(child(item, 'layer'), 1) !== `${side}.SilkS`) continue;
    const tag = item[0];
    if (tag === 'property' || tag === 'fp_text') {
      const effects = child(item, 'effects');
      const hidden = item.includes('hide') || atom(child(item, 'hide'), 1) === 'yes' || Boolean(effects?.includes('hide')) || atom(child(effects ?? [], 'hide'), 1) === 'yes';
      const at = child(item, 'at');
      const local = pointOf(at);
      if (hidden || !local) continue;
      const text = atom(item, 2) ?? '';
      if (!text) continue;
      const font = child(effects ?? [], 'font');
      const size = pointOf(child(font ?? [], 'size')) ?? { x: 1.27, y: 1.27 };
      const thickness = num(atom(child(font ?? [], 'thickness'), 1), 0.15);
      const width = Math.max(size.x * 0.6, text.length * size.x * 0.7);
      const justify = new Set((child(effects ?? [], 'justify') ?? []).slice(1).filter((value): value is string => typeof value === 'string'));
      const x0 = justify.has('left') ? 0 : justify.has('right') ? -width : -width / 2;
      const y0 = justify.has('top') ? 0 : justify.has('bottom') ? -size.y : -size.y / 2;
      const center = place(local, origin, rotation);
      const angle = num(atom(at, 3), rotation);
      const polygon = envelope(
        [
          { x: x0, y: y0 },
          { x: x0 + width, y: y0 },
          { x: x0 + width, y: y0 + size.y },
          { x: x0, y: y0 + size.y },
        ].map((point) => place(point, center, angle)),
        thickness / 2,
      );
      if (polygon) out.push(polygon);
      continue;
    }
    if (!/^fp_(line|rect|circle|arc|poly)$/.test(tag)) continue;
    const points = graphicPoints(item).map((point) => place(point, origin, rotation));
    const width = num(atom(child(child(item, 'stroke') ?? [], 'width'), 1), 0.15);
    const polygon = envelope(points, width / 2);
    if (polygon) out.push(polygon);
  }
  return out;
}

function layerList(node: SexpNode[]): string[] {
  const layers = child(node, 'layers') ?? child(node, 'layer');
  return (layers ?? []).slice(1).filter((value): value is string => typeof value === 'string');
}

function propertyOf(fp: SexpNode[], name: string): string {
  for (const property of children(fp, 'property')) if (atom(property, 1) === name) return atom(property, 2) ?? '';
  for (const text of children(fp, 'fp_text')) if (atom(text, 1) === name.toLowerCase()) return atom(text, 2) ?? '';
  return '';
}

function zonePolygon(zone: SexpNode[]): P[] {
  const polygon = child(zone, 'polygon');
  return children(child(polygon ?? [], 'pts') ?? [], 'xy')
    .map((xy) => pointOf(xy))
    .filter((p): p is P => p !== null);
}

function keepoutOf(zone: SexpNode[]): Keepout | null {
  const keepout = child(zone, 'keepout');
  if (!keepout) return null;
  const blocked = (flag: string): boolean => atom(child(keepout, flag), 1) === 'not_allowed';
  const polygon = zonePolygon(zone);
  if (polygon.length < 3) return null;
  return {
    name: atom(child(zone, 'name'), 1) ?? '',
    layers: layerList(zone),
    polygon,
    footprintsBlocked: blocked('footprints'),
    copperBlocked: blocked('tracks') || blocked('copperpour'),
  };
}

/**
 * A pad's copper as a convex polygon in pad-local coordinates: circles and
 * ovals as inscribed polygons, round-rects with their corners chamfered at the
 * corner radius. Inscribed shapes never report a short that the true pad
 * would not have.
 */
function padOutline(shape: string, size: P, rratio: number): P[] {
  const hw = size.x / 2;
  const hh = size.y / 2;
  if (shape === 'circle' || shape === 'oval') {
    const r = Math.min(hw, hh);
    const cx = hw - r;
    const cy = hh - r;
    const out: P[] = [];
    for (let i = 0; i < 16; i++) {
      const t = (i * Math.PI) / 8;
      const x = r * Math.cos(t);
      const y = r * Math.sin(t);
      out.push({ x: x + (x >= 0 ? cx : -cx), y: y + (y >= 0 ? cy : -cy) });
    }
    return out;
  }
  if (shape === 'roundrect') {
    const c = Math.min(hw, hh) * 2 * Math.min(0.5, Math.max(0, rratio)) * (1 - Math.SQRT1_2);
    return [
      { x: -hw + c, y: -hh },
      { x: hw - c, y: -hh },
      { x: hw, y: -hh + c },
      { x: hw, y: hh - c },
      { x: hw - c, y: hh },
      { x: -hw + c, y: hh },
      { x: -hw, y: hh - c },
      { x: -hw, y: -hh + c },
    ];
  }
  return quad({ x: -hw, y: -hh }, { x: hw, y: hh }, { x: 0, y: 0 }, 0);
}

function padsOf(fp: SexpNode[], origin: P, rotation: number): Pad[] {
  const pads: Pad[] = [];
  for (const pad of children(fp, 'pad')) {
    const at = child(pad, 'at');
    const local = pointOf(at);
    const size = pointOf(child(pad, 'size'));
    if (!local || !size) continue;
    const absolute = num(atom(at, 3));
    const center = place(local, origin, rotation);
    const shape = atom(pad, 3) ?? '';
    const polygon = padOutline(shape, size, num(atom(child(pad, 'roundrect_rratio'), 1), 0.25)).map((point) => place(point, center, absolute));
    const netNode = child(pad, 'net');
    pads.push({
      number: atom(pad, 1) ?? '',
      kind: atom(pad, 2) ?? '',
      shape,
      local,
      localAngle: absolute - rotation,
      size,
      net: (netNode && netNode.length >= 3 ? atom(netNode, 2) : atom(netNode, 1)) ?? '',
      pintype: atom(child(pad, 'pintype'), 1) ?? '',
      layers: layerList(pad),
      center,
      polygon,
    });
  }
  return pads;
}

function partOf(fp: SexpNode[]): Part {
  const at = child(fp, 'at');
  const origin = pointOf(at) ?? { x: 0, y: 0 };
  const rotation = num(atom(at, 3));
  const side = (atom(child(fp, 'layer'), 1) ?? 'F.Cu').startsWith('B.') ? 'B' : 'F';
  const pads = padsOf(fp, origin, rotation);
  const courtyard = shapeLoops(fp, 'fp_', `${side}.CrtYd`);
  const padBox = pads.length
    ? boundsOf(pads.flatMap((pad) => quad({ x: -pad.size.x / 2, y: -pad.size.y / 2 }, { x: pad.size.x / 2, y: pad.size.y / 2 }, pad.local, pad.localAngle)))
    : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  const attr = child(fp, 'attr');
  const footprint = atom(fp, 1) ?? '';
  return {
    ref: propertyOf(fp, 'Reference'),
    footprint,
    value: propertyOf(fp, 'Value'),
    side,
    origin,
    rotation,
    boardOnly: Boolean(attr?.includes('board_only')),
    netTie: Boolean(child(fp, 'net_tie_pad_groups')) || /NetTie/i.test(footprint),
    tht: pads.some((pad) => pad.kind === 'thru_hole' || pad.kind === 'np_thru_hole'),
    pads,
    body: courtyard.length ? courtyard.map((loop) => loop.map((point) => place(point, origin, rotation))) : [quad(padBox.min, padBox.max, origin, rotation)],
    silk: silkEnvelopes(fp, origin, rotation, side),
    hasCourtyard: courtyard.length > 0,
    bodyAreaMm2: courtyard.length
      ? courtyard.reduce((sum, loop) => sum + polygonArea(loop), 0)
      : Math.max(0, padBox.max.x - padBox.min.x) * Math.max(0, padBox.max.y - padBox.min.y),
    keepouts: children(fp, 'zone')
      .map(keepoutOf)
      .filter((k): k is Keepout => k !== null),
  };
}

// ---------------------------------------------------------------- outline

/** Three points on an arc to a polyline of `segments` pieces. */
function arcPoints(start: P, mid: P, end: P, segments = 12): P[] {
  const d = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y));
  if (Math.abs(d) < 1e-12) return [start, end];
  const sq = (p: P): number => p.x * p.x + p.y * p.y;
  const center = {
    x: (sq(start) * (mid.y - end.y) + sq(mid) * (end.y - start.y) + sq(end) * (start.y - mid.y)) / d,
    y: (sq(start) * (end.x - mid.x) + sq(mid) * (start.x - end.x) + sq(end) * (mid.x - start.x)) / d,
  };
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  const angle = (p: P): number => Math.atan2(p.y - center.y, p.x - center.x);
  const a0 = angle(start);
  let sweepMid = angle(mid) - a0;
  let sweep = angle(end) - a0;
  sweepMid = mod(sweepMid, 2 * Math.PI);
  sweep = mod(sweep, 2 * Math.PI);
  if (sweepMid > sweep) sweep -= 2 * Math.PI;
  const out: P[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = a0 + (sweep * i) / segments;
    out.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  out[0] = start;
  out[out.length - 1] = end;
  return out;
}

/**
 * Closed loops drawn on one layer by `gr_*` (board) or `fp_*` (footprint)
 * graphics, largest first: rectangles, circles, polygons, and lines/arcs
 * stitched end to end. Unclosed strokes fall back to their bounding box.
 */
function shapeLoops(parent: SexpNode[], prefix: 'gr_' | 'fp_', layer: string): P[][] {
  const loops: P[][] = [];
  const chains: P[][] = [];
  for (const item of parent) {
    if (!isList(item) || typeof item[0] !== 'string' || !item[0].startsWith(prefix)) continue;
    if (atom(child(item, 'layer'), 1) !== layer) continue;
    const tag = item[0].slice(prefix.length);
    const start = pointOf(child(item, 'start'));
    const end = pointOf(child(item, 'end'));
    if (tag === 'rect' && start && end) {
      loops.push([start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }]);
    } else if (tag === 'circle') {
      const center = pointOf(child(item, 'center'));
      if (!center || !end) continue;
      const r = Math.hypot(end.x - center.x, end.y - center.y);
      loops.push(Array.from({ length: 32 }, (_, i) => ({ x: center.x + r * Math.cos((i * Math.PI) / 16), y: center.y + r * Math.sin((i * Math.PI) / 16) })));
    } else if (tag === 'poly') {
      const pts = children(child(item, 'pts') ?? [], 'xy')
        .map((xy) => pointOf(xy))
        .filter((p): p is P => p !== null);
      if (pts.length >= 3) loops.push(pts);
    } else if (tag === 'line' && start && end) {
      chains.push([start, end]);
    } else if (tag === 'arc' && start && end) {
      const mid = pointOf(child(item, 'mid'));
      chains.push(mid ? arcPoints(start, mid, end) : [start, end]);
    }
  }
  // stitch lines and arcs end to end into closed loops
  const near = (a: P, b: P): boolean => Math.hypot(a.x - b.x, a.y - b.y) < 0.01;
  const pool = [...chains];
  const stray: P[] = [];
  while (pool.length) {
    let loop = pool.shift()!;
    let grew = true;
    while (grew && !near(loop[0]!, loop[loop.length - 1]!)) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const piece = pool[i]!;
        const tail = loop[loop.length - 1]!;
        if (near(piece[0]!, tail)) loop = [...loop, ...piece.slice(1)];
        else if (near(piece[piece.length - 1]!, tail)) loop = [...loop, ...[...piece].reverse().slice(1)];
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (loop.length >= 3 && near(loop[0]!, loop[loop.length - 1]!)) loops.push(loop.slice(0, -1));
    else stray.push(...loop);
  }
  if (stray.length) {
    const box = boundsOf(stray);
    loops.push(quad(box.min, box.max, { x: 0, y: 0 }, 0));
  }
  return loops.sort((a, b) => polygonArea(b) - polygonArea(a));
}

// ---------------------------------------------------------------- classification

const EDGE_CONNECTOR = /USB|Barrel|DC_?Jack|Jack_DC|RJ\d\d|8P8C|6P6C|Jack_3\.5|Jack_6\.35|AudioJack|HDMI|DisplayPort|EdgeMount|Edge_Mount/i;
const OVERHANG_OK = /Connector|USB|Jack|Header|Terminal|Socket|Card|Button|Switch|SW_|LED_.*Side|Antenna|Edge|MountingHole|RF_Module/i;
const RADIO_MODULE = /RF_Module|Antenna|WROOM|WROVER|ESP32|nRF|BM\d\d|CC\d{4}|RFM\d|XBee|LoRa/i;
const GROUND = /(^|\/)(A|D|P|S|C)?GND[A-Z0-9_]*$|(^|\/)VSS[A-Z0-9_]*$|(^|\/)0V$|(^|\/)EARTH$/i;
const POWER_NAME = /(^|\/)(\+?\d+V\d*|\d+V\d+|VCC\w*|VDD\w*|AVDD\w*|DVDD\w*|IOVDD\w*|VBUS\w*|VBAT\w*|VIN\w*|VSYS\w*|VREG\w*|VOUT\w*|VREF\w*|V3V3|3V3\w*|1V8\w*|1V1\w*|5V\w*|PWR\w*)$/i;

const isIc = (part: Part): boolean => /^(U|IC)\d/i.test(part.ref) || part.pads.filter((pad) => pad.net).length >= 6;

/** "100n", "4.7uF", "10 µF", "1u" → farads; NaN when unparsable. */
export function capacitanceOf(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([pnuµm]?)(\d*)\s*F?/i.exec(value);
  if (!match) return Number.NaN;
  const scale: Record<string, number> = { '': 1, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3 };
  const unit = match[2]!.toLowerCase();
  const whole = Number(match[1]);
  const frac = match[3] ? Number(`0.${match[3]}`) : 0;
  return (whole + frac) * (scale[unit] ?? 1);
}

// ---------------------------------------------------------------- checks

function copperLayersOf(pad: Pad, side: 'F' | 'B'): string[] {
  const copper = pad.layers.filter((layer) => layer.endsWith('.Cu'));
  if (copper.some((layer) => layer === '*.Cu' || layer === 'F&B.Cu')) return ['F.Cu', 'B.Cu'];
  return copper.length ? copper : [`${side}.Cu`];
}

function layersShare(a: string[], b: string[]): boolean {
  return a.some((layer) => b.includes(layer));
}

function countCopper(root: SexpNode[]): CopperCounts {
  return {
    segments: children(root, 'segment').length,
    arcs: children(root, 'arc').length,
    vias: children(root, 'via').length,
    zones: children(root, 'zone').filter((zone) => !child(zone, 'keepout')).length,
  };
}

export function checkPlacementText(boardText: string): PlacementCheckReport {
  const root = parseSexp(boardText)[0];
  if (!root || !isList(root) || root[0] !== 'kicad_pcb') throw new Error('not a KiCad PCB s-expression file');
  const parts = children(root, 'footprint')
    .map(partOf)
    .sort((a, b) => byRef(a.ref, b.ref));
  const placed = parts.filter((part) => !part.boardOnly || part.pads.length > 0);
  const findings: PlacementFinding[] = [];
  const error = (id: PlacementCheckId, refs: string[], detail: string): void => {
    findings.push({ id, severity: 'error', refs, detail });
  };
  const warn = (id: PlacementCheckId, refs: string[], detail: string): void => {
    findings.push({ id, severity: 'warning', refs, detail });
  };

  // pad-overlap: copper of different nets touching, within or across footprints
  const allPads = placed.flatMap((part) =>
    // unnumbered pads are paste/thermal apertures inside a numbered pad, not separate copper
    part.pads.filter((pad) => pad.kind !== 'np_thru_hole' && pad.number !== '').map((pad) => ({ part, pad, layers: copperLayersOf(pad, part.side) })),
  );
  const padShorts = new Set<string>();
  for (let i = 0; i < allPads.length; i++) {
    const a = allPads[i]!;
    for (let j = i + 1; j < allPads.length; j++) {
      const b = allPads[j]!;
      if (a.part === b.part && (a.pad.number === b.pad.number || a.part.netTie)) continue;
      if (a.pad.net && a.pad.net === b.pad.net) continue;
      if (!a.pad.net && !b.pad.net && a.part === b.part) continue;
      if (!layersShare(a.layers, b.layers) || !boxesMayTouch(a.pad.polygon, b.pad.polygon)) continue;
      if (convexPenetration(a.pad.polygon, b.pad.polygon) <= EPS) continue;
      const key = [a.part.ref, b.part.ref].sort(byRef).join(' / ');
      if (padShorts.has(key)) continue;
      padShorts.add(key);
      error(
        'pad-overlap',
        [...new Set([a.part.ref, b.part.ref])],
        a.part === b.part
          ? `${a.part.ref} pads ${a.pad.number} (${a.pad.net || 'no net'}) and ${b.pad.number} (${b.pad.net || 'no net'}) overlap: the pads are not at their library angle/position`
          : `${a.part.ref}.${a.pad.number} (${a.pad.net || 'no net'}) overlaps ${b.part.ref}.${b.pad.number} (${b.pad.net || 'no net'})`,
      );
    }
  }

  // courtyard-overlap: same side; tht-underside: through-hole leads under an opposite-side part
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i]!;
    for (let j = i + 1; j < placed.length; j++) {
      const b = placed[j]!;
      const bodiesMayTouch = boxesMayTouch(a.body.flat(), b.body.flat());
      if (a.side === b.side) {
        if (a.silk.some((x) => b.silk.some((y) => boxesMayTouch(x, y) && polygonsIntersect(x, y)))) {
          warn('silkscreen-overlap', [a.ref, b.ref], `${a.ref} and ${b.ref} silkscreen envelopes overlap on ${a.side}.SilkS`);
        }
        if (bodiesMayTouch && a.hasCourtyard && b.hasCourtyard && bodiesIntersect(a.body, b.body)) {
          error('courtyard-overlap', [a.ref, b.ref], `${a.ref} and ${b.ref} courtyards overlap on ${a.side}.CrtYd`);
        }
        continue;
      }
      if (!bodiesMayTouch) continue;
      for (const [tht, other] of [
        [a, b],
        [b, a],
      ] as const) {
        if (!tht.tht) continue;
        const lead = tht.pads.find(
          (pad) => (pad.kind === 'thru_hole' || pad.kind === 'np_thru_hole') && bodiesIntersect([pad.polygon], other.body),
        );
        if (lead) warn('tht-underside', [tht.ref, other.ref], `${tht.ref} through-hole pad ${lead.number || '(npth)'} is under ${other.ref} on the opposite side`);
      }
    }
  }

  // outline
  const loops = shapeLoops(root, 'gr_', 'Edge.Cuts');
  const outer = loops[0];
  const holes = loops.slice(1).filter((loop) => outer && loop.every((point) => pointInPolygon(point, outer)));
  const edgeTolerance = 1;
  const outlineEdges = outer ? [outer, ...holes] : [];
  const distanceToEdge = (poly: P[]): number => Math.min(...outlineEdges.map((loop) => boundaryDistance(poly, loop)));
  if (outer) {
    for (const part of placed) {
      const outside = part.pads.filter(
        (pad) =>
          pad.kind !== 'np_thru_hole' &&
          (!pad.polygon.every((point) => pointInPolygon(point, outer)) ||
            holes.some((hole) => polygonsIntersect(pad.polygon, hole))),
      );
      if (outside.length) {
        error(
          'outline-containment',
          [part.ref],
          `${part.ref} has ${outside.length} pad(s) outside the board outline (${outside.slice(0, 4).map((pad) => pad.number).join(', ')})`,
        );
      }
      const overhangs = part.hasCourtyard && !part.body.flat().every((point) => pointInPolygon(point, outer));
      if (overhangs && !outside.length && !OVERHANG_OK.test(part.footprint)) {
        warn('courtyard-overhang', [part.ref], `${part.ref} courtyard extends past the board outline`);
      }
    }
  }

  // footprint-keepout: footprint-embedded and board-level rule areas that exclude footprints
  const boardKeepouts = children(root, 'zone')
    .map(keepoutOf)
    .filter((k): k is Keepout => k !== null)
    .map((keepout) => ({ owner: null as Part | null, keepout }));
  const keepouts = [...boardKeepouts, ...placed.flatMap((part) => part.keepouts.map((keepout) => ({ owner: part as Part | null, keepout })))];
  for (const { owner, keepout } of keepouts) {
    if (!keepout.footprintsBlocked) continue;
    const onSide = (side: 'F' | 'B'): boolean =>
      keepout.layers.some((layer) => layer === `${side}.Cu` || layer === '*.Cu' || layer === 'F&B.Cu' || layer === `${side}&B.Cu`);
    for (const part of placed) {
      if (part === owner || !onSide(part.side) || !boxesMayTouch(part.body.flat(), keepout.polygon)) continue;
      if (bodiesIntersect(part.body, [keepout.polygon])) {
        error(
          'footprint-keepout',
          owner ? [part.ref, owner.ref] : [part.ref],
          `${part.ref} is inside ${owner ? `${owner.ref}'s` : 'the board'} keepout${keepout.name ? ` "${keepout.name}"` : ''}`,
        );
      }
    }
  }

  // edge-connector and antenna-edge
  if (outer) {
    for (const part of placed) {
      if (EDGE_CONNECTOR.test(part.footprint)) {
        const gap = Math.min(...part.body.map(distanceToEdge));
        const inside = part.body.flat().every((point) => pointInPolygon(point, outer));
        if (inside && gap > edgeTolerance) {
          error('edge-connector', [part.ref], `${part.ref} (${part.footprint.split(':').pop()}) is ${round(gap, 2)} mm from the nearest board edge; a mating connector must reach the edge`);
        }
      }
      for (const keepout of part.keepouts) {
        if (!keepout.copperBlocked || !keepout.footprintsBlocked) continue;
        if (!/ant/i.test(keepout.name) && !RADIO_MODULE.test(part.footprint)) continue;
        const inside = keepout.polygon.every((point) => pointInPolygon(point, outer));
        if (inside && distanceToEdge(keepout.polygon) > edgeTolerance) {
          warn('antenna-edge', [part.ref], `${part.ref}'s keepout${keepout.name ? ` "${keepout.name}"` : ''} is fully inside the board, ${round(distanceToEdge(keepout.polygon), 2)} mm from the edge (antenna keepouts belong at an edge)`);
        }
      }
    }
  }

  const copper = countCopper(root);

  // decoupling-distance and crystal-distance
  const nets = new Map<string, { part: Part; pad: Pad }[]>();
  for (const part of placed) for (const pad of part.pads) if (pad.net) nets.set(pad.net, [...(nets.get(pad.net) ?? []), { part, pad }]);
  const supplyPin = (pad: Pad): boolean => pad.pintype === 'power_in' || pad.pintype === 'power_out';
  const pintypesKnown = placed.some((part) => part.pads.some((pad) => pad.pintype));
  const decoupling: DecouplingMeasurement[] = [];
  const crystals: CrystalMeasurement[] = [];
  const decouplingMax = 6;
  const bulkMax = 15;
  const crystalMax = 6;
  for (const part of placed) {
    const netted = part.pads.filter((pad) => pad.net);
    const distinct = [...new Set(netted.map((pad) => pad.net))];
    if (/^C\d/i.test(part.ref) && netted.length === 2 && distinct.length === 2) {
      const ground = distinct.find((net) => GROUND.test(net));
      const rail = distinct.find((net) => net !== ground);
      if (!ground || !rail || GROUND.test(rail)) continue;
      const ics = (nets.get(rail) ?? []).filter(({ part: other, pad }) => other !== part && isIc(other) && (pintypesKnown ? supplyPin(pad) : true));
      // without pin types, only a supply-named rail is trusted (an XTAL or AREF cap is not decoupling)
      if (!ics.length || (!pintypesKnown && !POWER_NAME.test(rail))) continue;
      const railPad = netted.find((pad) => pad.net === rail)!;
      let best: { ic: string; d: number } | null = null;
      for (const { part: ic, pad } of ics) {
        const d = Math.hypot(pad.center.x - railPad.center.x, pad.center.y - railPad.center.y);
        if (!best || d < best.d) best = { ic: ic.ref, d };
      }
      const bulk = capacitanceOf(part.value) >= 4.7e-6;
      decoupling.push({ ref: part.ref, rail, ic: best?.ic ?? null, distanceMm: best ? round(best.d) : null, bulk });
      const limit = bulk ? bulkMax : decouplingMax;
      if (best && best.d > limit) {
        warn('decoupling-distance', [part.ref, best.ic], `${part.ref} (${part.value || '?'}, ${rail}) is ${round(best.d, 2)} mm from the nearest ${best.ic} supply pin (limit ${limit} mm)`);
      }
      continue;
    }
    const isCrystal = /^(Y|X|XTAL|XT)\d/i.test(part.ref) || /Crystal|Resonator/i.test(part.footprint);
    if (!isCrystal || /Oscillator/i.test(part.footprint)) continue;
    const signals = distinct.filter((net) => !GROUND.test(net) && !POWER_NAME.test(net));
    const distances: number[] = [];
    let owner: string | null = null;
    for (const net of signals) {
      const mine = netted.filter((pad) => pad.net === net);
      const ic = (nets.get(net) ?? []).filter(({ part: other }) => other !== part && isIc(other));
      let best = Infinity;
      for (const { part: other, pad } of ic) {
        for (const own of mine) {
          const d = Math.hypot(pad.center.x - own.center.x, pad.center.y - own.center.y);
          if (d < best) {
            best = d;
            owner = other.ref;
          }
        }
      }
      if (Number.isFinite(best)) distances.push(round(best));
    }
    if (!distances.length) continue;
    crystals.push({ ref: part.ref, ic: owner, distancesMm: distances });
    const worst = Math.max(...distances);
    if (worst > crystalMax) warn('crystal-distance', owner ? [part.ref, owner] : [part.ref], `${part.ref} is ${round(worst, 2)} mm from its ${owner ?? 'IC'} clock pin (limit ${crystalMax} mm)`);
  }

  const small = decoupling
    .filter((d) => !d.bulk && d.distanceMm !== null)
    .map((d) => d.distanceMm!)
    .sort((a, b) => a - b);
  const medianDecoupling = small.length ? small[Math.floor((small.length - 1) / 2)]! : null;
  const medianMax = 3;
  if (medianDecoupling !== null && small.length >= 3 && medianDecoupling > medianMax) {
    warn('decoupling-distance', [], `median decoupling distance is ${round(medianDecoupling, 2)} mm over ${small.length} capacitor(s) (limit ${medianMax} mm): decoupling is not clustered at its ICs`);
  }

  // utilization
  const outlineArea = outer ? polygonArea(outer) - holes.reduce((sum, hole) => sum + polygonArea(hole), 0) : 0;
  const courtyardArea = placed.reduce((sum, part) => sum + part.bodyAreaMm2, 0);
  const utilization = outer && outlineArea > 0 ? courtyardArea / outlineArea : null;
  const minUtilization = 0.25;
  if (utilization !== null && utilization < minUtilization) {
    warn('utilization', [], `courtyards cover ${Math.round(utilization * 100)}% of the board (minimum ${Math.round(minUtilization * 100)}%): the outline is larger than the parts need`);
  }

  // HPWL over pad centres
  let hpwl = 0;
  for (const members of nets.values()) {
    if (members.length < 2) continue;
    const box = boundsOf(members.map(({ pad }) => pad.center));
    hpwl += box.max.x - box.min.x + box.max.y - box.min.y;
  }

  const box = outer ? boundsOf(outer) : null;
  const errors = findings.filter((finding) => finding.severity === 'error');
  return {
    ok: errors.length === 0,
    errors,
    warnings: findings.filter((finding) => finding.severity === 'warning'),
    metrics: {
      components: placed.length,
      outline: box ? { widthMm: round(box.max.x - box.min.x), heightMm: round(box.max.y - box.min.y), areaMm2: round(outlineArea), loops: loops.length } : null,
      courtyardAreaMm2: round(courtyardArea),
      utilization: utilization === null ? null : round(utilization),
      hpwlMm: round(hpwl),
      copper,
      decoupling,
      medianDecouplingMm: medianDecoupling,
      crystals,
    },
  };
}
export interface PlacedPart {
  ref: string;
  footprint: string;
  side: 'F' | 'B';
  x: number;
  y: number;
  rotation: number;
}

/**
 * Where each part sits and the HPWL of every net: the raw material for
 * comparing two placements of one design (a candidate against a golden board).
 */
export function placementSummary(boardText: string): { parts: PlacedPart[]; netHpwlMm: Record<string, number> } {
  const root = parseSexp(boardText)[0];
  if (!root || !isList(root) || root[0] !== 'kicad_pcb') throw new Error('not a KiCad PCB s-expression file');
  const parts = children(root, 'footprint')
    .map(partOf)
    .filter((part) => !part.boardOnly || part.pads.length > 0)
    .sort((a, b) => byRef(a.ref, b.ref));
  const nets = new Map<string, P[]>();
  for (const part of parts) for (const pad of part.pads) if (pad.net) nets.set(pad.net, [...(nets.get(pad.net) ?? []), pad.center]);
  const netHpwlMm: Record<string, number> = {};
  for (const [net, points] of [...nets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (points.length < 2) continue;
    const box = boundsOf(points);
    netHpwlMm[net] = round(box.max.x - box.min.x + box.max.y - box.min.y, 6);
  }
  return {
    parts: parts.map((part) => ({ ref: part.ref, footprint: part.footprint, side: part.side, x: part.origin.x, y: part.origin.y, rotation: mod(part.rotation, 360) })),
    netHpwlMm,
  };
}

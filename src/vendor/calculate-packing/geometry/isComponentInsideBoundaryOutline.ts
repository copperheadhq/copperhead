// copperhead patch P2 (not upstream): exact containment of a component's boxes in the boundary outline.
import type { PackedComponent } from '../types.js';
import { getComponentCollisionBoxes } from '../PackSolver2/getComponentCollisionBoxes.js';

interface Pt {
  x: number;
  y: number;
}

interface CentredBox {
  center: Pt;
  width: number;
  height: number;
}

/** Tolerance in board units: a box flush with the outline counts as inside. */
const EPS = 1e-6;

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** A point inside the polygon (even-odd rule) or within EPS of its outline. */
export function isPointInOrOnPolygon(p: Pt, polygon: readonly Pt[]): boolean {
  const n = polygon.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (distanceToSegment(p, a, b) <= EPS) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Whether segment ab meets the box shrunk by EPS on every side
 * (Liang–Barsky clipping). A segment that only touches the box's edge does
 * not count.
 */
function segmentMeetsBoxInterior(a: Pt, b: Pt, minX: number, minY: number, maxX: number, maxY: number): boolean {
  const x0 = minX + EPS;
  const x1 = maxX - EPS;
  const y0 = minY + EPS;
  const y1 = maxY - EPS;
  if (x0 > x1 || y0 > y1) return false; // no interior to cross
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, a.x - x0) && clip(dx, x1 - a.x) && clip(-dy, a.y - y0) && clip(dy, y1 - a.y) && t0 <= t1;
}

/**
 * An axis-aligned box lies inside a simple polygon when all four corners are
 * inside (or on) it and no polygon segment crosses the box's interior.
 */
export function isBoxInsidePolygon(box: CentredBox, polygon: readonly Pt[]): boolean {
  const minX = box.center.x - box.width / 2;
  const maxX = box.center.x + box.width / 2;
  const minY = box.center.y - box.height / 2;
  const maxY = box.center.y + box.height / 2;
  const corners: Pt[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  if (!corners.every((c) => isPointInOrOnPolygon(c, polygon))) return false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if (segmentMeetsBoxInterior(a, b, minX, minY, maxX, maxY)) return false;
  }
  return true;
}

/**
 * Every collision box of the component (its courtyard box, or its pad boxes
 * when it has no courtyard) and every pad box lies inside the boundary
 * outline.
 */
export function isComponentInsideBoundaryOutline(component: PackedComponent, boundaryOutline: readonly Pt[]): boolean {
  const boxes: CentredBox[] = [
    ...getComponentCollisionBoxes(component),
    ...component.pads.map((pad) => ({ center: pad.absoluteCenter, width: pad.size.x, height: pad.size.y })),
  ];
  return boxes.every((box) => isBoxInsidePolygon(box, boundaryOutline));
}

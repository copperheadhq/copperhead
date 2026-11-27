/**
 * Placement intent checker (add-reuse-placer, pcb-placement-intent; RFC 14
 * §13): the checks that decide whether a placement is electrically sensible,
 * beside the intent checker's mechanical, attachment, group, and keepout
 * evaluators. Every check reports its measured value as a metric; a check
 * with a number from the constraint emits its diagnostic when violated, with
 * the constraint's severity (hard gates the placement).
 *
 * - C2 current loops: area of the polygon through the loop's pads in order
 * - C3 isolation, channels, crystal edge distance, radio module edge and clearance
 * - C5 ordered chains: projection order and detour
 * - subsystem intrusion: other subsystems' parts inside a subsystem's hull
 */
import type { PcbDesign, ComponentInstance, PadDefinition, Point } from '../../ir/types.js';
import type { Polygon } from '../../ir/geometry.js';
import { bboxOf, contains, distance as polyDistance } from '../../ir/geometry.js';
import type { Constraint } from '../../../memory/constraints.js';
import { make, statusOf, type Diagnostic, type Severity, type CheckResult } from '../diagnostic.js';

export const PLACEMENT_INTENT_CHECKER = { id: 'placement-intent', version: '1' };

const sev = (c: Constraint): Severity => (c.severity === 'hard' ? 'error' : c.severity === 'soft' ? 'warning' : 'info');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
const mm = (nm: number) => (nm / 1e6).toFixed(2);

function extent(c: ComponentInstance): Polygon | null {
  if (c.footprint.courtyard) return c.footprint.courtyard;
  if (!c.pads.length) return null;
  const b = bboxOf(c.pads.map((p) => p.copper));
  return { outer: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], holes: [] };
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Minimum distance from a polygon's vertices to the board outline's boundary (edges). */
export function edgeDistance(poly: Polygon, outline: Polygon): number {
  let best = Number.POSITIVE_INFINITY;
  const ring = outline.outer;
  for (const v of poly.outer) for (let i = 0; i < ring.length; i++) best = Math.min(best, segDist(v, ring[i]!, ring[(i + 1) % ring.length]!));
  return best;
}

export function shoelace(points: Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The loop's corner points: for each part in order, the pad on a net it shares
 * with the next part (or the previous one), nearest the previous corner. A
 * placement-time proxy for the loop area (RFC 15 §7.1).
 */
export function loopPoints(parts: ComponentInstance[]): Point[] {
  const pts: Point[] = [];
  const nets = (c: ComponentInstance) => new Set(c.pads.map((p) => p.netId).filter((n): n is string => !!n));
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i]!;
    const next = parts[(i + 1) % parts.length]!;
    const prev = parts[(i - 1 + parts.length) % parts.length]!;
    const shared = [...nets(c)].filter((n) => nets(next).has(n) || nets(prev).has(n));
    const candidates: PadDefinition[] = shared.length ? c.pads.filter((p) => p.netId && shared.includes(p.netId)) : c.pads;
    const last = pts[pts.length - 1] ?? c.at;
    const pick = [...candidates].sort((a, b) => Math.hypot(a.at.x - last.x, a.at.y - last.y) - Math.hypot(b.at.x - last.x, b.at.y - last.y))[0];
    // a part touching both neighbours through different pads contributes both corners
    const byNet = new Map<string, PadDefinition>();
    for (const p of candidates) if (p.netId && !byNet.has(p.netId)) byNet.set(p.netId, p);
    if (byNet.size >= 2 && shared.length >= 2) {
      const toPrev = [...byNet.values()].find((p) => nets(prev).has(p.netId!));
      const toNext = [...byNet.values()].find((p) => nets(next).has(p.netId!) && p !== toPrev);
      if (toPrev) pts.push(toPrev.at);
      if (toNext) pts.push(toNext.at);
      continue;
    }
    pts.push((pick ?? { at: c.at }).at);
  }
  return pts;
}

export function checkPlacementIntent(design: PcbDesign, registry: Record<string, Constraint>): CheckResult {
  const d: Diagnostic[] = [];
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const comps = (refs: string[]) => refs.map((r) => byRef.get(r)).filter((c): c is ComponentInstance => !!c);
  const minDistance = (a: ComponentInstance[], b: ComponentInstance[]) => {
    let best = Number.POSITIVE_INFINITY;
    let pair: [ComponentInstance, ComponentInstance] | null = null;
    for (const x of a) for (const y of b) {
      if (x.id === y.id) continue;
      const ex = extent(x), ey = extent(y);
      if (!ex || !ey) continue;
      const dd = polyDistance(ex, ey);
      if (dd < best) {
        best = dd;
        pair = [x, y];
      }
    }
    return { best, pair };
  };
  const metrics: Record<string, number> = {};
  const addMin = (k: string, v: number) => {
    if (Number.isFinite(v)) metrics[k] = Math.min(metrics[k] ?? Number.POSITIVE_INFINITY, v);
  };
  let loopArea = 0, loops = 0, chainViolations = 0, intrusions = 0, detourMax = 0;

  for (const [key, c] of Object.entries(registry)) {
    const p = c.parameters ?? {};
    if (key.startsWith('layout.emc.hot-loop.')) {
      const parts = comps(strs(p.parts).length ? strs(p.parts) : c.scope?.refs ?? []);
      if (parts.length < 2) continue;
      const area = shoelace(loopPoints(parts));
      loopArea += area;
      loops++;
      const max = num(p.max_area_nm2);
      if (max !== null && area > max) d.push(make(PLACEMENT_INTENT_CHECKER, 'intent.emc.hot-loop', { severity: sev(c), entityIds: parts.map((x) => x.id), entityReferences: parts.map((x) => x.reference), measured: { value: Math.round(area / 1e6), unit: 'nm' }, allowed: { value: Math.round(max / 1e6), unit: 'nm', relation: '<=' }, message: `${String(p.kind ?? 'switching')} loop ${parts.map((x) => x.reference).join('-')} encloses ${(area / 1e12).toFixed(1)} mm² against ${(max / 1e12).toFixed(1)} mm²`, suggestedActions: ['move-group'] }));
    } else if (key.startsWith('layout.emc.isolation.') || key.startsWith('layout.emc.channel.')) {
      const channel = key.startsWith('layout.emc.channel.');
      const a = comps(strs(channel ? p.left : p.noisy)), b = comps(strs(channel ? p.right : p.sensitive));
      if (!a.length || !b.length) continue;
      const { best, pair } = minDistance(a, b);
      addMin(channel ? 'channel_min_mm' : 'isolation_min_mm', best / 1e6);
      const min = num(p.min_nm);
      if (min !== null && pair && best < min) d.push(make(PLACEMENT_INTENT_CHECKER, channel ? 'intent.emc.channel' : 'intent.emc.isolation', { severity: sev(c), entityIds: pair.map((x) => x.id), entityReferences: pair.map((x) => x.reference), measured: { value: Math.round(best), unit: 'nm' }, allowed: { value: min, unit: 'nm', relation: '>=' }, message: `${pair[0].reference} and ${pair[1].reference} are ${mm(best)} mm apart against ${mm(min)} mm`, suggestedActions: ['move-group'] }));
    } else if (key.startsWith('layout.emc.edge-distance.')) {
      const part = comps(c.scope?.refs ?? [key.split('.').pop() ?? ''])[0];
      const e = part ? extent(part) : null;
      if (!part || !e) continue;
      const toEdge = edgeDistance(e, design.board.outline);
      const connectors = design.components.filter((x) => x.id !== part.id && /^(J|P|CON|X|USB)\d/i.test(x.reference));
      const toConn = minDistance([part], connectors).best;
      const dist = Math.min(toEdge, toConn);
      addMin('crystal_edge_min_mm', dist / 1e6);
      const min = num(p.min_nm);
      if (min !== null && dist < min) d.push(make(PLACEMENT_INTENT_CHECKER, 'intent.emc.edge-distance', { severity: sev(c), entityIds: [part.id], entityReferences: [part.reference], measured: { value: Math.round(dist), unit: 'nm' }, allowed: { value: min, unit: 'nm', relation: '>=' }, message: `${part.reference} is ${mm(dist)} mm from the board edge or a connector against ${mm(min)} mm`, suggestedActions: ['move-group'] }));
    } else if (key.startsWith('layout.rf.edge.')) {
      const part = comps(c.scope?.refs ?? [key.split('.').pop() ?? ''])[0];
      const e = part ? extent(part) : null;
      if (!part || !e) continue;
      const toEdge = edgeDistance(e, design.board.outline);
      metrics.rf_edge_mm = Math.max(metrics.rf_edge_mm ?? 0, toEdge / 1e6);
      if (toEdge > 1_000_000) d.push(make(PLACEMENT_INTENT_CHECKER, 'intent.rf.edge', { severity: sev(c), entityIds: [part.id], entityReferences: [part.reference], measured: { value: Math.round(toEdge), unit: 'nm' }, allowed: { value: 1_000_000, unit: 'nm', relation: '<=' }, message: `${part.reference} sits ${mm(toEdge)} mm from the nearest board edge; the antenna side belongs at the edge`, suggestedActions: ['move-group'] }));
      const clearance = num(p.clearance_nm);
      const others = design.components.filter((x) => x.id !== part.id);
      const near = minDistance([part], others);
      addMin('rf_clearance_min_mm', near.best / 1e6);
      if (clearance !== null && near.pair && near.best < clearance) d.push(make(PLACEMENT_INTENT_CHECKER, 'intent.rf.clearance', { severity: sev(c), entityIds: near.pair.map((x) => x.id), entityReferences: near.pair.map((x) => x.reference), measured: { value: Math.round(near.best), unit: 'nm' }, allowed: { value: clearance, unit: 'nm', relation: '>=' }, message: `${near.pair[1].reference} is ${mm(near.best)} mm from radio module ${part.reference} against ${mm(clearance)} mm`, suggestedActions: ['move-group'] }));
    } else if (key.startsWith('layout.relative.chain.')) {
      const order = comps(strs(p.order));
      if (order.length < 3) continue;
      const first = order[0]!.at, last = order[order.length - 1]!.at;
      const ax = last.x - first.x, ay = last.y - first.y;
      const len = Math.hypot(ax, ay) || 1;
      let prevT = Number.NEGATIVE_INFINITY;
      for (const part of order) {
        const t = ((part.at.x - first.x) * ax + (part.at.y - first.y) * ay) / len;
        const e = extent(part);
        const tol = e ? Math.min(bboxOf([e]).maxX - bboxOf([e]).minX, bboxOf([e]).maxY - bboxOf([e]).minY) / 2 : 0;
        if (t + tol < prevT) {
          chainViolations++;
          d.push(make(PLACEMENT_INTENT_CHECKER, 'intent.relative.chain.order', { severity: sev(c), entityIds: [part.id], entityReferences: [part.reference], measured: { value: Math.round(t), unit: 'nm' }, allowed: { value: Math.round(prevT), unit: 'nm', relation: '>=' }, message: `${part.reference} is out of order in chain ${order.map((x) => x.reference).join(' -> ')}`, suggestedActions: ['move-group'] }));
        }
        prevT = Math.max(prevT, t);
      }
      let path = 0;
      for (let i = 1; i < order.length; i++) path += Math.hypot(order[i]!.at.x - order[i - 1]!.at.x, order[i]!.at.y - order[i - 1]!.at.y);
      const detour = path / len;
      detourMax = Math.max(detourMax, detour);
      const maxLen = num(p.max_length_nm);
      if (maxLen !== null && path > maxLen) d.push(make(PLACEMENT_INTENT_CHECKER, 'intent.relative.chain.length', { severity: sev(c), entityIds: order.map((x) => x.id), entityReferences: order.map((x) => x.reference), measured: { value: Math.round(path), unit: 'nm' }, allowed: { value: maxLen, unit: 'nm', relation: '<=' }, message: `chain ${order.map((x) => x.reference).join(' -> ')} spans ${mm(path)} mm against ${mm(maxLen)} mm`, suggestedActions: ['move-group'] }));
    } else if (key.startsWith('layout.functional.group.')) {
      const members = comps(strs(p.members));
      if (members.length < 3) continue;
      const hull = convexHull(members.map((m) => m.at));
      if (hull.length < 3) continue;
      const poly: Polygon = { outer: hull, holes: [] };
      const memberIds = new Set(members.map((m) => m.id));
      const inside = design.components.filter((x) => !memberIds.has(x.id) && x.pads.some((pad) => pad.netId) && contains(poly, x.at));
      if (inside.length) {
        intrusions += inside.length;
        d.push(make(PLACEMENT_INTENT_CHECKER, 'intent.functional.group.intrusion', { severity: 'warning', entityIds: inside.map((x) => x.id), entityReferences: inside.map((x) => x.reference), measured: { value: inside.length, unit: 'count' }, allowed: { value: 0, unit: 'count', relation: '<=' }, message: `${inside.map((x) => x.reference).join(', ')} inside subsystem ${key.slice('layout.functional.group.'.length)}`, suggestedActions: ['move-group'] }));
      }
    }
  }
  metrics.loop_area_mm2 = loopArea / 1e12;
  metrics.loop_count = loops;
  metrics.chain_order_violations = chainViolations;
  metrics.chain_detour_ratio = detourMax;
  metrics.intrusion_count = intrusions;
  metrics.placement_intent_hard_violations = d.filter((x) => x.severity === 'error').length;
  return { checker: PLACEMENT_INTENT_CHECKER, status: statusOf(d), diagnostics: d, metrics, evidence: [] };
}

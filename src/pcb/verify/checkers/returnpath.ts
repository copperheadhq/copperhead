/**
 * Two-layer return-path checker (RFC 11 §9.5, §10.6; implementation spec
 * §5.3): the bottom copper is the return path, every signal segment on it
 * cuts that path. Reports pour contiguity, bottom-layer signal length, top
 * signals crossing a pour gap, and stitching vias near connectors. Metrics
 * and advisory diagnostics; a pour crossing gates only for nets tagged
 * sensitive (Phase 4).
 */
import type { PcbDesign, ZoneFill } from '../../ir/types.js';
import { copperStack } from '../../ir/layers.js';
import { area, contains, centroid, bbox, type Polygon } from '../../ir/geometry.js';
import { make, statusOf, type CheckResult, type Diagnostic } from '../diagnostic.js';

export const RETURNPATH_CHECKER = { id: 'copperhead-returnpath', version: '1' };

const GROUND = /^(GND|GNDA|GNDD|AGND|DGND|PGND|VSS|0V|GROUND)$/i;

export function checkReturnPath(design: PcbDesign, fills: ZoneFill[], opts: { sensitiveNetIds?: Set<string> } = {}): CheckResult {
  const copper = copperStack(design);
  const top = copper[0];
  const bottom = copper[copper.length - 1];
  const d: Diagnostic[] = [];
  const metrics: Record<string, number> = {};
  if (!bottom || !top || copper.length !== 2) return { checker: RETURNPATH_CHECKER, status: 'NOT_APPLICABLE', diagnostics: [], metrics: {}, evidence: [{ kind: 'note', note: 'return-path checks apply to two-layer boards' }] };
  const groundIds = new Set(design.nets.filter((n) => GROUND.test(n.name)).map((n) => n.id));
  const zoneNet = new Map(design.routing.zones.map((z) => [z.id, z.netId]));
  const groundFills: Polygon[] = fills.filter((f) => f.layer === bottom && groundIds.has(zoneNet.get(f.zoneId) ?? '')).flatMap((f) => f.polygons);
  if (groundFills.length) {
    const areas = groundFills.map(area);
    const total = areas.reduce((s, a) => s + a, 0);
    metrics.pour_fragments = groundFills.length;
    metrics.pour_largest_share = total ? Math.max(...areas) / total : 0;
    if (groundFills.length > 1) d.push(make(RETURNPATH_CHECKER, 'quality.pour.fragments', { entityIds: [], entityReferences: [...groundIds].map((id) => design.nets.find((n) => n.id === id)!.name), measured: { value: groundFills.length, unit: 'count' }, allowed: { value: 1, unit: 'count', relation: '<=' }, message: `the bottom ground pour is split into ${groundFills.length} islands (largest ${(metrics.pour_largest_share * 100).toFixed(0)}% of the copper)`, suggestedActions: ['rip-up-nets', 'change-net-priority'] }));
  } else {
    metrics.pour_fragments = 0;
    metrics.pour_largest_share = 0;
  }
  let bottomSignal = 0;
  for (const s of design.routing.segments) if (s.layer === bottom && !groundIds.has(s.netId)) bottomSignal += Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  metrics.bottom_signal_length_nm = Math.round(bottomSignal);
  // top-layer signal segments whose midpoint has no ground copper under it
  let crossings = 0;
  if (groundFills.length) {
    for (const s of design.routing.segments) {
      if (s.layer !== top || groundIds.has(s.netId)) continue;
      const mid = { x: Math.round((s.a.x + s.b.x) / 2), y: Math.round((s.a.y + s.b.y) / 2) };
      if (!groundFills.some((p) => contains(p, mid))) {
        crossings++;
        if (opts.sensitiveNetIds?.has(s.netId)) {
          d.push(make(RETURNPATH_CHECKER, 'quality.pour.crossing', { severity: 'error', entityIds: [s.id], entityReferences: [design.nets.find((n) => n.id === s.netId)?.name ?? '?'], message: 'a sensitive signal runs over a gap in the return plane', suggestedActions: ['rip-up-nets', 'move-group'] }));
        }
      }
    }
  }
  metrics.pour_crossings = crossings;
  // stitching vias within 5 mm of each connector
  const connectors = design.components.filter((c) => /^(J|P|USB|CN|X)\d/.test(c.reference));
  let stitchTotal = 0;
  for (const c of connectors) {
    const ctr = c.footprint.courtyard ? centroid(c.footprint.courtyard) : c.at;
    const near = design.routing.vias.filter((v) => groundIds.has(v.netId) && Math.hypot(v.at.x - ctr.x, v.at.y - ctr.y) <= 5e6).length;
    stitchTotal += near;
    if (groundFills.length && near === 0) d.push(make(RETURNPATH_CHECKER, 'quality.stitching', { entityIds: [c.id], entityReferences: [c.reference], region: c.footprint.courtyard ?? undefined, message: `${c.reference} has no ground stitching via within 5 mm`, suggestedActions: [] }));
  }
  metrics.stitching_vias_per_connector = connectors.length ? stitchTotal / connectors.length : 0;
  void bbox;
  return { checker: RETURNPATH_CHECKER, status: statusOf(d), diagnostics: d, metrics, evidence: [] };
}

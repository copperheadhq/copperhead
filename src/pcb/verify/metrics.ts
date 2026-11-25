/**
 * Candidate metrics (RFC 11 §11.1, §11.2; ADR 0001). The PCBWorld-protocol
 * values (`pcbworld.*`) follow the paper's definitions: clean pass, routability
 * over owed connections, DRV count (errors only), wirelength, via count, time.
 * Potential Gain is not computed (it is a function of PCBWorld's reward
 * code). The rest are copperhead's own.
 */
import type { PcbDesign } from '../ir/types.js';
import { copperStack } from '../ir/layers.js';
import { capsule, distance as polyDistance } from '../ir/geometry.js';
import type { VerifyResult } from './index.js';

export interface RoutingMetricsInput {
  design: PcbDesign;
  verify: VerifyResult;
  /** The design before routing, for the owed-connection baseline. */
  baseline?: PcbDesign;
  runtimeSeconds?: number;
  peakMemoryMb?: number;
}

const len = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);

/** Owed connections of a design with no copper: Σ (pads − 1) over nets with ≥ 2 pads. */
export function owedBaseline(design: PcbDesign): number {
  return design.nets.reduce((s, n) => s + Math.max(0, n.padIds.length - 1), 0);
}

export function routingMetrics(input: RoutingMetricsInput): Record<string, number> {
  const { design, verify } = input;
  const m = verify.metrics;
  let wirelength = 0;
  for (const s of design.routing.segments) wirelength += len(s.a, s.b);
  for (const a of design.routing.arcs) wirelength += len(a.a, a.mid) + len(a.mid, a.b);
  // bends and acute angles: consecutive segments of one net sharing an endpoint
  let bends = 0;
  let acute = 0;
  const byNet = new Map<string, typeof design.routing.segments>();
  for (const s of design.routing.segments) {
    if (!byNet.has(s.netId)) byNet.set(s.netId, []);
    byNet.get(s.netId)!.push(s);
  }
  for (const segs of byNet.values()) {
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    const ends = new Map<string, { dx: number; dy: number }[]>();
    for (const s of segs) {
      const d = { dx: s.b.x - s.a.x, dy: s.b.y - s.a.y };
      for (const [p, dir] of [[s.a, d], [s.b, { dx: -d.dx, dy: -d.dy }]] as const) {
        const k = key(p);
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k)!.push(dir);
      }
    }
    for (const dirs of ends.values()) {
      if (dirs.length !== 2) continue;
      const [u, v] = dirs as [{ dx: number; dy: number }, { dx: number; dy: number }];
      const dot = u.dx * v.dx + u.dy * v.dy;
      const cos = dot / (Math.hypot(u.dx, u.dy) * Math.hypot(v.dx, v.dy) || 1);
      // straight-through means opposite directions at the shared point (cos = -1)
      if (cos > -0.999) bends++;
      if (cos > 0.001) acute++; // the two outgoing directions form an angle under 90 degrees
    }
  }
  const owed0 = input.baseline ? owedBaseline(input.baseline) : owedBaseline(design);
  const owed = m.unrouted_count ?? 0;
  const drcCritical = m.drc_critical_count ?? 0;
  const drcErrors = m.drc_error_count ?? 0;
  const out: Record<string, number> = {
    completion_rate: m.completion_rate ?? 0,
    unrouted_count: owed,
    shorts: m.shorts ?? 0,
    drc_error_count: drcErrors,
    drc_critical_count: drcCritical,
    drc_warning_count: m.drc_warning_count ?? 0,
    total_wirelength_nm: Math.round(wirelength),
    via_count: design.routing.vias.length,
    bend_count: bends,
    acute_angle_count: acute,
    ...clearanceMargin(design),
    layer_transition_count: design.routing.vias.length,
    runtime_s: input.runtimeSeconds ?? 0,
    peak_memory_mb: input.peakMemoryMb ?? 0,
    'pcbworld.clean_pass': owed === 0 && drcErrors === 0 && (m.shorts ?? 0) === 0 ? 1 : 0,
    'pcbworld.routability': owed0 ? Math.max(0, (owed0 - owed) / owed0) : 1,
    'pcbworld.drv': drcErrors,
    'pcbworld.wirelength_mm': Math.round(wirelength / 1e4) / 100,
    'pcbworld.via_count': design.routing.vias.length,
    'pcbworld.time_s': input.runtimeSeconds ?? 0,
  };
  for (const [k, v] of Object.entries(m)) if (k.startsWith('pour_') || k.startsWith('bottom_') || k === 'stitching_vias_per_connector' || k === 'congestion_overflow') out[k] = v;
  return out;
}

/**
 * Placement metrics (implementation spec §8.1): half-perimeter wirelength over
 * pad centres, a 2 mm-cell congestion proxy, and the gate-relevant counts. The
 * routability pair (`routability_completion`, `routability_drc_errors`) is
 * added by the probe in engines/probe.ts when it runs.
 */
export function placementMetrics(input: { design: PcbDesign; verify: VerifyResult; runtimeSeconds?: number }): Record<string, number> {
  const { design, verify } = input;
  const padAt = new Map<string, { x: number; y: number }>();
  for (const c of design.components) for (const p of c.pads) padAt.set(p.id, p.at);
  let hpwl = 0;
  const boxes: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
  for (const n of design.nets) {
    const pts = n.padIds.map((id) => padAt.get(id)).filter((p): p is { x: number; y: number } => !!p);
    if (pts.length < 2) continue;
    const b = { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) };
    hpwl += b.maxX - b.minX + (b.maxY - b.minY);
    boxes.push(b);
  }
  // congestion proxy: nets whose bounding box covers a 2 mm cell each want a track through it;
  // capacity is how many tracks at width + clearance fit across the cell per copper layer
  const cell = 2_000_000;
  const rules = design.board.rules;
  const copperLayers = copperStack(design).length || 2;
  const capacity = Math.max(1, Math.floor(cell / (rules.trackWidthNm + rules.clearanceNm))) * copperLayers;
  const outline = design.board.outline.outer;
  const bx = { minX: Math.min(...outline.map((p) => p.x)), minY: Math.min(...outline.map((p) => p.y)), maxX: Math.max(...outline.map((p) => p.x)), maxY: Math.max(...outline.map((p) => p.y)) };
  const cols = Math.max(1, Math.ceil((bx.maxX - bx.minX) / cell));
  const rows = Math.max(1, Math.ceil((bx.maxY - bx.minY) / cell));
  const demand = new Int32Array(cols * rows);
  for (const b of boxes) {
    const c0 = Math.max(0, Math.floor((b.minX - bx.minX) / cell)), c1 = Math.min(cols - 1, Math.floor((b.maxX - bx.minX) / cell));
    const r0 = Math.max(0, Math.floor((b.minY - bx.minY) / cell)), r1 = Math.min(rows - 1, Math.floor((b.maxY - bx.minY) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) demand[r * cols + c]!++;
  }
  let overflow = 0;
  for (let i = 0; i < demand.length; i++) if (demand[i]! > capacity) overflow++;
  const count = (code: string) => verify.diagnostics.filter((d) => d.code === code && d.severity === 'error').length;
  return {
    hpwl_nm: hpwl,
    congestion_overflow: overflow,
    courtyard_overlap_count: count('geom.courtyard-overlap'),
    outside_board_count: count('geom.outside-board'),
    component_count: design.components.length,
    runtime_s: input.runtimeSeconds ?? 0,
  };
}

/**
 * Margin: the smallest copper-to-copper gap between different nets (segment to segment and segment to pad, same layer),
 * as a ratio to the rule, and the share of segments that sit within 10 % of the rule. Engines route at the rule
 * unless asked otherwise; these say how much air the candidate left.
 */
export function clearanceMargin(design: PcbDesign): { clearance_min_ratio: number; tight_segment_share: number } {
  const rule = design.board.rules.clearanceNm || 1;
  const segs = design.routing.segments;
  if (!segs.length) return { clearance_min_ratio: 1, tight_segment_share: 0 };
  const pads = design.components.flatMap((c) => c.pads.map((p) => ({ netId: p.netId, layers: p.layers, poly: p.copper, at: p.at })));
  const caps = segs.map((s) => ({ s, poly: capsule(s.a, s.b, s.width), cx: (s.a.x + s.b.x) / 2, cy: (s.a.y + s.b.y) / 2, r: Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) / 2 + s.width }));
  let min = Number.POSITIVE_INFINITY;
  let tight = 0;
  const near = rule * 1.1;
  for (let i = 0; i < caps.length; i++) {
    const a = caps[i]!;
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < caps.length; j++) {
      if (i === j) continue;
      const b = caps[j]!;
      if (a.s.netId === b.s.netId || a.s.layer !== b.s.layer) continue;
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) > a.r + b.r + rule * 4) continue; // cannot be closer than 4 rules
      best = Math.min(best, polyDistance(a.poly, b.poly));
      if (best <= near) break;
    }
    if (best > near) for (const p of pads) {
      if (p.netId === a.s.netId || !p.layers.includes(a.s.layer)) continue;
      if (Math.hypot(a.cx - p.at.x, a.cy - p.at.y) > a.r + rule * 6) continue;
      best = Math.min(best, polyDistance(a.poly, p.poly));
      if (best <= near) break;
    }
    if (best < min) min = best;
    if (best <= near) tight++;
  }
  return { clearance_min_ratio: Number.isFinite(min) ? Math.round((min / rule) * 1000) / 1000 : 1, tight_segment_share: Math.round((tight / segs.length) * 1000) / 1000 };
}

/**
 * The metrics RFC 15 Section 11.1's tiers rank on that the intent checkers
 * report as findings, not as numbers: soft violations by tier, and how far
 * past their limits they are. Hard violations are gates and are counted
 * elsewhere. A finding states what was measured and what was allowed, in
 * nanometres, so the excess is the one less the other.
 */
export function tierMetrics(diagnostics: Array<{ code: string; severity: string; measured?: { value: number }; allowed?: { value: number; relation?: string } }>): Record<string, number> {
  const soft = diagnostics.filter((d) => d.code.startsWith('intent.') && d.severity === 'warning');
  const excessMm = (d: (typeof soft)[number]): number | null =>
    d.measured && d.allowed && d.allowed.relation === '<=' ? Math.max(0, d.measured.value - d.allowed.value) / 1e6 : null;
  const mechanical = soft.filter((d) => d.code.startsWith('intent.mechanical.'));
  // T2: decoupling, bootstrap, config, and crystal attachments, and output chains
  const datasheet = soft.filter((d) => d.code === 'intent.relative.attached' || d.code.startsWith('intent.relative.chain.'));
  const excesses = datasheet.map(excessMm).filter((v): v is number => v !== null);
  return {
    mechanical_soft_violations: mechanical.length,
    mechanical_offset_mm: mechanical.reduce((s, d) => s + (excessMm(d) ?? 0), 0),
    datasheet_soft_violations: datasheet.length,
    datasheet_excess_mm: excesses.length ? excesses.reduce((s, v) => s + v, 0) / excesses.length : 0,
    radio_thermal_violations: soft.filter((d) => d.code.startsWith('intent.rf.') || d.code.startsWith('intent.thermal.')).length,
    separation_violations: soft.filter((d) => d.code === 'intent.emc.isolation' || d.code === 'intent.emc.channel').length,
  };
}

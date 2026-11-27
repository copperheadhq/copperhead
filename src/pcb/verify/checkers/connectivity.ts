/**
 * Connectivity checker (RFC 11 §10.2, implementation spec §5.3): union-find
 * over pads, segments, arcs, vias, and zone fills, joined by copper contact on
 * a shared layer. Opens, shorts, and the unrouted count are copperhead's own
 * authority (ADR 0002: KiCad's ratsnest is cross-checked, not trusted alone).
 */
import type { PcbDesign, ZoneFill } from '../../ir/types.js';
import { copperStack, viaSpan } from '../../ir/layers.js';
import { capsule, circle, intersects, bbox, bboxOverlap, type Polygon, type BBox } from '../../ir/geometry.js';
import { arcPoints } from '../../ir/kicad/import.js';
import { make, statusOf, type CheckResult, type Diagnostic } from '../diagnostic.js';

export const CONNECTIVITY_CHECKER = { id: 'copperhead-connectivity', version: '1' };

interface Obj {
  id: string;
  kind: 'pad' | 'segment' | 'arc' | 'via' | 'fill';
  netId: string | null;
  layers: string[];
  poly: Polygon;
  box: BBox;
  ref: string; // human reference: "U1.8", net name, zone
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

export function checkConnectivity(design: PcbDesign, fills: ZoneFill[] = []): CheckResult {
  const netName = new Map(design.nets.map((n) => [n.id, n.name]));
  const zoneNet = new Map(design.routing.zones.map((z) => [z.id, z.netId]));
  const objs: Obj[] = [];
  const padOwner = new Map<string, string>();
  for (const c of design.components) {
    for (const p of c.pads) {
      if (!p.layers.length || p.type === 'np_thru_hole') continue;
      objs.push({ id: p.id, kind: 'pad', netId: p.netId, layers: p.layers, poly: p.copper, box: bbox(p.copper), ref: `${c.reference}.${p.number}` });
      padOwner.set(p.id, c.reference);
    }
  }
  for (const s of design.routing.segments) {
    const poly = capsule(s.a, s.b, s.width);
    objs.push({ id: s.id, kind: 'segment', netId: s.netId || null, layers: [s.layer], poly, box: bbox(poly), ref: netName.get(s.netId) ?? '?' });
  }
  for (const a of design.routing.arcs) {
    const pts = arcPoints(a.a, a.mid, a.b);
    for (let i = 0; i + 1 < pts.length; i++) {
      const poly = capsule(pts[i]!, pts[i + 1]!, a.width);
      objs.push({ id: `${a.id}#${i}`, kind: 'arc', netId: a.netId || null, layers: [a.layer], poly, box: bbox(poly), ref: netName.get(a.netId) ?? '?' });
    }
  }
  const stack = copperStack(design);
  for (const v of design.routing.vias) {
    const poly = circle(v.at.x, v.at.y, v.size);
    // a via joins every layer between its ends (a through via on four layers reaches In1.Cu and In2.Cu)
    objs.push({ id: v.id, kind: 'via', netId: v.netId || null, layers: viaSpan(v, stack), poly, box: bbox(poly), ref: netName.get(v.netId) ?? '?' });
  }
  for (const f of fills) {
    const net = zoneNet.get(f.zoneId);
    if (net === undefined || net === null) continue;
    f.polygons.forEach((poly, i) => objs.push({ id: `${f.zoneId}#${f.layer}#${i}`, kind: 'fill', netId: net, layers: [f.layer], poly, box: bbox(poly), ref: `zone ${netName.get(net) ?? '?'}` }));
  }

  // arcs of one record are contiguous by construction
  const uf = new UnionFind(objs.length);
  const byLayer = new Map<string, number[]>();
  objs.forEach((o, i) => {
    for (const l of o.layers) {
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(i);
    }
  });
  for (const idx of byLayer.values()) {
    for (let a = 0; a < idx.length; a++) {
      const oa = objs[idx[a]!]!;
      for (let b = a + 1; b < idx.length; b++) {
        const ob = objs[idx[b]!]!;
        if (!bboxOverlap(oa.box, ob.box)) continue;
        if (intersects(oa.poly, ob.poly)) uf.union(idx[a]!, idx[b]!);
      }
    }
  }
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i]!;
    if (o.kind === 'arc') {
      const base = o.id.split('#')[0]!;
      const prev = objs.findIndex((p) => p.id === `${base}#${Number(o.id.split('#')[1]) - 1}`);
      if (prev >= 0) uf.union(i, prev);
    }
  }

  const d: Diagnostic[] = [];
  // shorts: a cluster holding objects of two nets
  const clusters = new Map<number, number[]>();
  objs.forEach((_, i) => {
    const r = uf.find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(i);
  });
  const shorted = new Set<string>();
  for (const members of clusters.values()) {
    const nets = new Set(members.map((i) => objs[i]!.netId).filter((n): n is string => !!n));
    if (nets.size > 1) {
      const names = [...nets].map((n) => netName.get(n) ?? n).sort();
      const key = names.join('|');
      if (shorted.has(key)) continue;
      shorted.add(key);
      const touching = members.filter((i) => objs[i]!.kind === 'pad' || objs[i]!.kind === 'segment' || objs[i]!.kind === 'via');
      d.push(make(CONNECTIVITY_CHECKER, 'conn.short', {
        entityIds: touching.map((i) => objs[i]!.id),
        entityReferences: [...names, ...touching.filter((i) => objs[i]!.kind === 'pad').map((i) => objs[i]!.ref)],
        ...(touching[0] !== undefined ? { region: objs[touching[0]]!.poly } : {}),
        message: `copper joins nets ${names.join(' and ')}`,
        suggestedActions: ['rip-up-nets'],
      }));
    }
  }

  // opens and unrouted per net: pads grouped by cluster
  let unroutedTotal = 0;
  let routedNets = 0;
  for (const net of design.nets) {
    const padIdx = objs.map((o, i) => (o.kind === 'pad' && o.netId === net.id ? i : -1)).filter((i) => i >= 0);
    if (padIdx.length < 2) continue;
    const groups = new Map<number, number[]>();
    for (const i of padIdx) {
      const r = uf.find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(i);
    }
    // copper of the net touching no pad is an island of its own, as KiCad counts it (a stub between two buried vias owes a connection at each end)
    let copperIslands = 0;
    const seen = new Set(groups.keys());
    objs.forEach((o, i) => {
      if (o.netId !== net.id || o.kind === 'pad' || o.kind === 'fill') return;
      const r = uf.find(i);
      if (seen.has(r)) return;
      seen.add(r);
      copperIslands++;
    });
    const missing = groups.size + copperIslands - 1;
    const hasCopper = objs.some((o) => o.kind !== 'pad' && o.netId === net.id);
    if (missing > 0) {
      unroutedTotal += missing;
      const groupRefs = [...groups.values()].map((g) => g.map((i) => objs[i]!.ref).join('+'));
      d.push(make(CONNECTIVITY_CHECKER, 'conn.unrouted', { entityIds: padIdx.map((i) => objs[i]!.id), entityReferences: [net.name], measured: { value: missing, unit: 'count' }, allowed: { value: 0, unit: 'count', relation: '==' }, message: `net ${net.name} owes ${missing} connection(s): ${groupRefs.join(' | ')}`, suggestedActions: ['change-net-priority', 'select-router'] }));
      if (hasCopper) d.push(make(CONNECTIVITY_CHECKER, 'conn.open', { entityIds: padIdx.map((i) => objs[i]!.id), entityReferences: [net.name, ...groupRefs], message: `net ${net.name} has copper but is split into ${groups.size} islands: ${groupRefs.join(' | ')}`, suggestedActions: ['rip-up-nets', 'change-net-priority'] }));
    } else routedNets++;
  }
  // dangling copper: a segment or via touching nothing else on its net
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i]!;
    if (o.kind !== 'segment' && o.kind !== 'via') continue;
    const r = uf.find(i);
    const alone = (clusters.get(r) ?? []).length === 1;
    if (alone) d.push(make(CONNECTIVITY_CHECKER, 'conn.dangling', { entityIds: [o.id], entityReferences: [o.ref], message: `${o.kind} on net ${o.ref} touches no other copper`, suggestedActions: ['rip-up-nets'] }));
  }
  const netsWithPads = design.nets.filter((n) => n.padIds.length >= 2).length;
  return {
    checker: CONNECTIVITY_CHECKER,
    status: statusOf(d),
    diagnostics: d,
    metrics: { unrouted_count: unroutedTotal, routed_nets: routedNets, nets_with_connections: netsWithPads, completion_rate: netsWithPads ? routedNets / netsWithPads : 1, shorts: shorted.size },
    evidence: [],
  };
}

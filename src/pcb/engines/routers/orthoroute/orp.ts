/**
 * OrthoRoute's file formats (bbenchoff/OrthoRoute, docs/ORP_ORS_file_formats.md): `.ORP` carries the
 * board a router sees (bounds, layers, pads with net names, rules, grid pitch), `.ORS` the solution
 * (tracks and vias per net). Both are JSON, gzip-compressed on disk. Millimetres, y up, so the IR's
 * y (nanometres, y down) is negated on the way out and back.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { copperStack } from '../../../ir/layers.js';
import { uuidv5 } from '../../../../kicad/emit.js';
import type { PcbDesign, TrackSegment, Via, DesignRules } from '../../../ir/types.js';
import { bbox } from '../../../ir/geometry.js';

const mm = (nm: number): number => Math.round(nm) / 1e6;
const nm = (v: number): number => Math.round(v * 1e6);

export interface OrpOptions {
  boardName: string;
  /** Route only these nets (null: every net with two or more pads). */
  netIds: Set<string> | null;
  gridPitchMm?: number;
  clearanceNm?: number;
  trackWidthNm?: number;
}

export function buildOrp(design: PcbDesign, opts: OrpOptions): Record<string, unknown> {
  const copper = copperStack(design);
  const ob = bbox(design.board.outline);
  const rules = design.board.rules;
  const netById = new Map(design.nets.map((n) => [n.id, n]));
  const wanted = new Set(design.nets.filter((n) => n.padIds.length >= 2 && (!opts.netIds || opts.netIds.has(n.id))).map((n) => n.id));
  const pads: Record<string, unknown>[] = [];
  for (const c of design.components) {
    for (const p of c.pads) {
      if (!p.netId || !wanted.has(p.netId)) continue;
      const th = p.type === 'thru_hole';
      pads.push({
        id: `${c.reference}@${p.number}`,
        component_ref: c.reference,
        net_name: netById.get(p.netId)!.name,
        position: { x: mm(p.at.x), y: -mm(p.at.y) },
        size: { width: mm(p.size.w), height: mm(p.size.h) },
        layer: th ? copper[0] : p.layers.includes(copper[copper.length - 1]!) && !p.layers.includes(copper[0]!) ? copper[copper.length - 1] : copper[0],
        drill_size: th && p.drill ? mm(p.drill.d) : null,
      });
    }
  }
  return {
    format_version: '1.0',
    metadata: { board_name: opts.boardName, exporter: 'copperhead' },
    board: { bounds: { x_min: mm(ob.minX), y_min: -mm(ob.maxY), x_max: mm(ob.maxX), y_max: -mm(ob.minY), width: mm(ob.maxX - ob.minX), height: mm(ob.maxY - ob.minY) }, layer_count: copper.length },
    layers: copper.map((id) => ({ name: id })),
    pads,
    nets: [...wanted].map((id) => ({ id: netById.get(id)!.name, name: netById.get(id)!.name })),
    drc_rules: { default: { clearance: mm(opts.clearanceNm ?? rules.clearanceNm), track_width: mm(opts.trackWidthNm ?? rules.trackWidthNm), via_diameter: mm(rules.viaDiameterNm), via_drill: mm(rules.viaDrillNm) } },
    grid_parameters: { grid_pitch: opts.gridPitchMm ?? 0.4 },
  };
}

/**
 * The nets the returned copper plausibly connects: two or more of the net's pads have a track end or a via on them.
 * OrthoRoute's own counters are not usable for this (its pad-escape stubs are copper on nets it never finished, and its
 * last-iteration `nets_routed` reads 0 on a run that converged at once); the verifier's connectivity check is the judge,
 * this only sets the engine's status.
 */
export function netsTouched(design: PcbDesign, copper: { segments: TrackSegment[]; vias: Via[] }): Set<string> {
  const ends = new Map<string, { x: number; y: number }[]>();
  const add = (netId: string, p: { x: number; y: number }) => { const l = ends.get(netId) ?? []; l.push(p); ends.set(netId, l); };
  for (const s of copper.segments) { add(s.netId, s.a); add(s.netId, s.b); }
  for (const v of copper.vias) add(v.netId, v.at);
  const out = new Set<string>();
  for (const n of design.nets) {
    const pts = ends.get(n.id);
    if (!pts || n.padIds.length < 2) continue;
    let hit = 0;
    for (const c of design.components) for (const p of c.pads) {
      if (p.netId !== n.id) continue;
      const r = Math.max(p.size.w, p.size.h) / 2 + design.board.rules.trackWidthNm;
      if (pts.some((q) => Math.hypot(q.x - p.at.x, q.y - p.at.y) <= r)) hit++;
    }
    if (hit >= 2) out.add(n.id);
  }
  return out;
}

export function encodeOrp(orp: Record<string, unknown>): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(orp), 'utf8'));
}

export interface OrsResult {
  segments: TrackSegment[];
  vias: Via[];
  /** Net names that received copper. */
  nets: string[];
  converged: boolean | null;
  iterations: number | null;
  /** Nets the engine itself counts as routed on its last iteration (its pad-escape stubs are copper on nets it did not finish). */
  netsRouted: number | null;
}

/** Reads an `.ORS` (gzip or plain JSON) into IR copper. Tracks name their layer; vias name or index the layers they span. */
export function parseOrs(data: Buffer, ctx: { copperLayers: string[]; netIdByName: Map<string, string>; rules: DesignRules; namespace: string }): OrsResult {
  let text: string;
  try {
    text = gunzipSync(data).toString('utf8');
  } catch {
    text = data.toString('utf8');
  }
  const ors = JSON.parse(text) as { metadata?: { converged?: boolean; total_iterations?: number }; iteration_metrics?: { nets_routed?: number }[]; geometry?: { all_tracks?: Record<string, unknown>[]; all_vias?: Record<string, unknown>[] } };
  const last = ors.iteration_metrics?.length ? ors.iteration_metrics[ors.iteration_metrics.length - 1] : undefined;
  const layerOf = (v: unknown): string | null => {
    if (typeof v === 'number') return ctx.copperLayers[v] ?? null;
    if (typeof v === 'string') return ctx.copperLayers.includes(v) ? v : null;
    return null;
  };
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const point = (v: unknown): { x: number; y: number } | null => {
    if (Array.isArray(v) && v.length >= 2) return { x: nm(num(v[0])), y: -nm(num(v[1])) };
    if (v && typeof v === 'object') { const o = v as Record<string, unknown>; return { x: nm(num(o.x)), y: -nm(num(o.y)) }; }
    return null;
  };
  const segments: TrackSegment[] = [];
  const vias: Via[] = [];
  const nets = new Set<string>();
  let k = 0;
  for (const t of ors.geometry?.all_tracks ?? []) {
    const name = String(t.net_id ?? t.net ?? '');
    const netId = ctx.netIdByName.get(name);
    const layer = layerOf(t.layer);
    const a = point(t.start), b = point(t.end);
    if (!netId || !layer || !a || !b || (a.x === b.x && a.y === b.y)) continue;
    segments.push({ id: uuidv5(`ors/${name}/seg/${k++}`, ctx.namespace), netId, layer, a, b, width: Math.max(nm(num(t.width)), ctx.rules.trackWidthNm) });
    nets.add(name);
  }
  let v = 0;
  for (const via of ors.geometry?.all_vias ?? []) {
    const name = String(via.net_id ?? via.net ?? '');
    const netId = ctx.netIdByName.get(name);
    const at = point(via.position);
    const from = layerOf(via.from_layer) ?? ctx.copperLayers[0]!;
    const to = layerOf(via.to_layer) ?? ctx.copperLayers[ctx.copperLayers.length - 1]!;
    if (!netId || !at) continue;
    vias.push({ id: uuidv5(`ors/${name}/via/${v++}`, ctx.namespace), netId, at, size: nm(num(via.diameter, mm(ctx.rules.viaDiameterNm))), drill: nm(num(via.drill, mm(ctx.rules.viaDrillNm))), layers: [from, to] });
    nets.add(name);
  }
  return { segments, vias, nets: [...nets], converged: typeof ors.metadata?.converged === 'boolean' ? ors.metadata.converged : null, iterations: typeof ors.metadata?.total_iterations === 'number' ? ors.metadata.total_iterations : null, netsRouted: typeof last?.nets_routed === 'number' ? last.nets_routed : null };
}

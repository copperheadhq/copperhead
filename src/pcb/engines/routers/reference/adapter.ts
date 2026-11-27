/**
 * router-reference (ADR 0008): a small grid A* router over two copper layers
 * with vias, marked harnessOnly. It exists so the harness has a deterministic
 * router in CI with no external binary; it is ineligible for production jobs
 * and competes with nothing (RFC 11 §3.1, §3.8).
 *
 * Model: a uniform grid; every cell on a layer is free, blocked by foreign
 * copper (pads and existing tracks of other nets, expanded by the clearance),
 * or owned by the net being routed. Each net is routed pad to pad along a
 * minimum spanning tree of its pads; each pair is an A* search where a layer
 * change costs a via. Paths become axis-aligned segments; vias are placed at
 * layer changes.
 */
import type { EngineManifest, RoutingJob, RoutingResult, RouterPlugin, RunContext } from '../../contracts.js';
import { copperStack } from '../../../ir/layers.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { PcbDesign, TrackSegment, Via, PadDefinition } from '../../../ir/types.js';
import { bbox, capsule, contains, type Point } from '../../../ir/geometry.js';
import { uuidv5 } from '../../../../kicad/emit.js';

export const REFERENCE_ROUTER_MANIFEST: EngineManifest = {
  id: 'router-reference',
  kind: 'router',
  version: '1',
  adapterVersion: '1',
  license: 'Apache-2.0',
  inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  determinism: 'deterministic',
  executionMode: 'library',
  networkRequirement: 'none',
  harnessOnly: true,
  requires: {},
  capabilities: { maxLayers: 2, differentialPairs: false, lengthMatching: false, pushAndShove: false, partialRouting: true, preserveExistingRoutes: true, arbitraryAngles: false, blindBuriedVias: false, copperZones: false },
  supportedConstraints: [],
};

const GRID = 250_000; // 0.25 mm
const VIA_COST = 12;
const LAYER_CHANGE_ITER_LIMIT = 400_000;

interface Grid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** owner[layer][idx] = netId that owns the cell for a track centre, '' when free, '#' when blocked for everyone. */
  owner: string[][];
  /** Same, grown by the via radius instead of the track half-width: where a via centre may sit. */
  viaOwner: string[][];
}

function cellOf(g: Grid, p: Point): [number, number] {
  return [Math.round((p.x - g.x0) / GRID), Math.round((p.y - g.y0) / GRID)];
}

/** Cells whose centres fall inside the polygon's bounding box grown by `growNm`. */
function cellsOf(g: Grid, poly: { x: number; y: number }[], growNm: number): number[] {
  const b = bbox({ outer: poly, holes: [] });
  const cx0 = Math.max(0, Math.ceil((b.minX - growNm - g.x0) / GRID));
  const cx1 = Math.min(g.w - 1, Math.floor((b.maxX + growNm - g.x0) / GRID));
  const cy0 = Math.max(0, Math.ceil((b.minY - growNm - g.y0) / GRID));
  const cy1 = Math.min(g.h - 1, Math.floor((b.maxY + growNm - g.y0) / GRID));
  const out: number[] = [];
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) out.push(y * g.w + x);
  return out;
}

/** Mark the halo (copper grown by the clearance) as owned by `owner` in one map; contested cells block everyone. */
function paintMap(map: string[][], g: Grid, layerIdx: number, poly: { x: number; y: number }[], owner: string, growNm: number): void {
  const row = map[layerIdx]!;
  for (const i of cellsOf(g, poly, growNm)) {
    if (row[i] === '' || row[i] === owner) row[i] = owner;
    else if (row[i] !== owner) row[i] = '#';
  }
}

/** Paint an obstacle into both maps: track halo (clearance + track half-width) and via halo (clearance + via radius). */
function paintPoly(g: Grid, layerIdx: number, poly: { x: number; y: number }[], owner: string, trackGrow: number, viaGrow = trackGrow): void {
  paintMap(g.owner, g, layerIdx, poly, owner, trackGrow);
  paintMap(g.viaOwner, g, layerIdx, poly, owner, viaGrow);
}

function buildGrid(design: PcbDesign, layers: string[], clearance: number, viaClearance: number): Grid {
  const b = bbox(design.board.outline);
  const margin = 2 * GRID;
  const x0 = b.minX + margin;
  const y0 = b.minY + margin;
  const w = Math.max(1, Math.floor((b.maxX - margin - x0) / GRID) + 1);
  const h = Math.max(1, Math.floor((b.maxY - margin - y0) / GRID) + 1);
  const owner = layers.map(() => new Array<string>(w * h).fill(''));
  const viaOwner = layers.map(() => new Array<string>(w * h).fill(''));
  const g: Grid = { x0, y0, w, h, owner, viaOwner };
  for (const c of design.components) {
    for (const p of c.pads) {
      const own = p.netId ?? '#';
      for (const l of p.layers) {
        const li = layers.indexOf(l);
        if (li >= 0) paintPoly(g, li, p.copper.outer, own, clearance, viaClearance);
      }
    }
  }
  for (const s of design.routing.segments) {
    const li = layers.indexOf(s.layer);
    if (li >= 0) paintPoly(g, li, capsule(s.a, s.b, s.width).outer, s.netId || '#', clearance, viaClearance);
  }
  for (const v of design.routing.vias) {
    for (const l of v.layers) {
      const li = layers.indexOf(l);
      if (li >= 0) paintPoly(g, li, capsule(v.at, v.at, v.size).outer, v.netId || '#', clearance, viaClearance);
    }
  }
  return g;
}

/** A* from a source cell set to a target cell set across layers. */
function astar(g: Grid, netId: string, sources: [number, number, number][], targets: Set<string>, layers: number): [number, number, number][] | null {
  const key = (x: number, y: number, l: number) => `${x},${y},${l}`;
  const targetCells = [...targets].map((t) => t.split(',').map(Number) as [number, number, number]);
  const hfn = (x: number, y: number) => Math.min(...targetCells.map((t) => Math.abs(t[0] - x) + Math.abs(t[1] - y)));
  const open: { f: number; g: number; x: number; y: number; l: number }[] = [];
  const came = new Map<string, string>();
  const best = new Map<string, number>();
  for (const [x, y, l] of sources) {
    open.push({ f: hfn(x, y), g: 0, x, y, l });
    best.set(key(x, y, l), 0);
  }
  let iterations = 0;
  while (open.length && iterations++ < LAYER_CHANGE_ITER_LIMIT) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.f < open[bi]!.f) bi = i;
    const cur = open.splice(bi, 1)[0]!;
    const ck = key(cur.x, cur.y, cur.l);
    if (targets.has(ck)) {
      const pathCells: [number, number, number][] = [];
      let k: string | undefined = ck;
      while (k) {
        const [x, y, l] = k.split(',').map(Number) as [number, number, number];
        pathCells.push([x, y, l]);
        k = came.get(k);
      }
      return pathCells.reverse();
    }
    if ((best.get(ck) ?? Infinity) < cur.g) continue;
    const moves: [number, number, number, number][] = [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1]];
    if (layers > 1) moves.push([0, 0, 1, VIA_COST]);
    for (const [dx, dy, dl, cost] of moves) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nl = dl ? (cur.l + 1) % layers : cur.l;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const o = g.owner[nl]![ny * g.w + nx]!;
      if (o !== '' && o !== netId) continue;
      if (dl) {
        // a via needs its own, wider halo free (or ours) on every layer
        let ok = true;
        for (let l = 0; l < layers; l++) {
          const oo = g.viaOwner[l]![ny * g.w + nx]!;
          if (oo !== '' && oo !== netId) ok = false;
        }
        if (!ok) continue;
      }
      const nk = key(nx, ny, nl);
      const ng = cur.g + cost;
      if (ng >= (best.get(nk) ?? Infinity)) continue;
      best.set(nk, ng);
      came.set(nk, ck);
      open.push({ f: ng + hfn(nx, ny), g: ng, x: nx, y: ny, l: nl });
    }
  }
  return null;
}

export class ReferenceRouter implements RouterPlugin {
  async manifest(): Promise<EngineManifest> {
    return REFERENCE_ROUTER_MANIFEST;
  }

  async route(job: RoutingJob, ctx: RunContext): Promise<RoutingResult> {
    const t0 = Date.now();
    const design = job.snapshot.design;
    const layers = copperStack(design).slice(0, 2);
    const rules = design.board.rules;
    const width = rules.trackWidthNm;
    const clearance = rules.clearanceNm + width / 2;
    const viaClearance = rules.clearanceNm + rules.viaDiameterNm / 2;
    const g = buildGrid(design, layers, clearance, viaClearance);
    const wanted = new Set(job.scope.netIds ?? design.nets.map((n) => n.id));
    const segments: TrackSegment[] = [];
    const vias: Via[] = [];
    const unrouted: string[] = [];
    const ns = uuidv5(`route/${job.runId}`);
    const nets = design.nets.filter((n) => wanted.has(n.id) && n.padIds.length >= 2).sort((a, b) => a.padIds.length - b.padIds.length || a.name.localeCompare(b.name));
    const padById = new Map<string, PadDefinition>();
    for (const c of design.components) for (const p of c.pads) padById.set(p.id, p);
    let done = 0;
    for (const net of nets) {
      const pads = net.padIds.map((id) => padById.get(id)!).filter((p) => p.layers.some((l) => layers.includes(l)));
      // copper cells of each pad on each of its layers (at least its centre cell)
      const padCells = pads.map((p) => {
        const [cx, cy] = cellOf(g, p.at);
        const centre = [Math.max(0, Math.min(g.w - 1, cx)), Math.max(0, Math.min(g.h - 1, cy))] as const;
        const out: [number, number, number][] = [];
        for (const l of p.layers) {
          if (!layers.includes(l)) continue;
          const li = layers.indexOf(l);
          // only cells whose centre is inside the copper: a round pad's bounding-box corners are not copper
          const core = cellsOf(g, p.copper.outer, 0)
            .filter((i) => contains(p.copper, { x: g.x0 + (i % g.w) * GRID, y: g.y0 + Math.floor(i / g.w) * GRID }))
            .map((i) => [i % g.w, Math.floor(i / g.w), li] as [number, number, number]);
          out.push(...(core.length ? core : [[centre[0], centre[1], li] as [number, number, number]]));
        }
        return out;
      });
      // the net's connected copper so far: starts as the first pad, grows with every route
      const tree = new Set<string>(padCells[0]!.map(([x, y, l]) => `${x},${y},${l}`));
      // Prim over pads by Manhattan distance of centres
      const connected = new Set<number>([0]);
      let failed = false;
      while (connected.size < pads.length) {
        let bi = -1;
        let bj = -1;
        let bd = Infinity;
        for (const i of connected) for (let j = 0; j < pads.length; j++) {
          if (connected.has(j)) continue;
          const d = Math.abs(pads[i]!.at.x - pads[j]!.at.x) + Math.abs(pads[i]!.at.y - pads[j]!.at.y);
          if (d < bd) {
            bd = d;
            bi = i;
            bj = j;
          }
        }
        if (bj < 0) break;
        // sources: the connected tree (pads reached plus copper routed); targets: the new pad's cells
        const sources = [...tree].map((k) => k.split(',').map(Number) as [number, number, number]);
        const targets = new Set(padCells[bj]!.map(([x, y, l]) => `${x},${y},${l}`));
        const cells = astar(g, net.id, sources, targets, layers.length);
        if (!cells) {
          failed = true;
          break;
        }
        // lower the path: straight runs become segments; layer changes become vias
        let runStart = cells[0]!;
        for (let k = 1; k <= cells.length; k++) {
          const prev = cells[k - 1]!;
          const cur = cells[k];
          const turn = !cur || cur[2] !== prev[2] || (k >= 2 && (cur[0] - prev[0] !== prev[0] - cells[k - 2]![0] || cur[1] - prev[1] !== prev[1] - cells[k - 2]![1]));
          if (turn) {
            if (runStart[0] !== prev[0] || runStart[1] !== prev[1]) {
              const a = { x: g.x0 + runStart[0] * GRID, y: g.y0 + runStart[1] * GRID };
              const b = { x: g.x0 + prev[0] * GRID, y: g.y0 + prev[1] * GRID };
              segments.push({ id: uuidv5(`seg/${net.name}/${segments.length}`, ns), netId: net.id, layer: layers[prev[2]]!, a, b, width });
              paintPoly(g, prev[2], capsule(a, b, width).outer, net.id, clearance, viaClearance);
              for (const i of cellsOf(g, capsule(a, b, width).outer, 0)) tree.add(`${i % g.w},${Math.floor(i / g.w)},${prev[2]}`);
            }
            if (cur && cur[2] !== prev[2]) {
              const at = { x: g.x0 + prev[0] * GRID, y: g.y0 + prev[1] * GRID };
              vias.push({ id: uuidv5(`via/${net.name}/${vias.length}`, ns), netId: net.id, at, size: rules.viaDiameterNm, drill: rules.viaDrillNm, layers: [layers[0]!, layers[1]!] });
              for (let l = 0; l < layers.length; l++) {
                paintPoly(g, l, capsule(at, at, rules.viaDiameterNm).outer, net.id, clearance, viaClearance);
                tree.add(`${prev[0]},${prev[1]},${l}`);
              }
            }
            // the corner belongs to both runs, so consecutive segments overlap instead of touching at a point
            runStart = prev;
          }
        }
        for (const [x, y, l] of padCells[bj]!) tree.add(`${x},${y},${l}`);
        for (const c of cells) tree.add(`${c[0]},${c[1]},${c[2]}`);
        connected.add(bj);
      }
      if (failed) unrouted.push(net.id);
      ctx.progress?.(++done / Math.max(1, nets.length), net.name);
    }
    const wall = (Date.now() - t0) / 1000;
    return {
      status: unrouted.length ? (segments.length ? 'partial' : 'failed') : 'complete',
      segments,
      arcs: [],
      vias,
      unroutedNetIds: unrouted,
      diagnostics: [],
      runtime: { wallSeconds: wall, engineSeconds: wall },
      provenance: { engineId: REFERENCE_ROUTER_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() },
    };
  }
}

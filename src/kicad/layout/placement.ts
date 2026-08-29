/**
 * Deterministic in-repo placement (issues #252 and #141): connectivity-aware
 * ordering over the schematic's net graph, followed by the original
 * area-descending grid/shelf packer.
 *
 * The old placer knew nothing about connectivity — a decoupling cap could land
 * far from its IC, which is exactly the "grid, not a layout" fallback #141
 * names. The ordering added here closes the largest part of that gap without
 * replacing the packer: components that share a low-fanout signal net are laid
 * down consecutively, so the router's nets stay short instead of spanning the
 * board. The packer still guarantees no overlap and keeps every courtyard inside
 * the board edge.
 *
 * Net weight is *inverse-fanout*: a two-pin signal net contributes weight 1 to
 * its one pair, while a 26-pin GND star contributes ~0.04 to each of its pairs.
 * Without that, a power rail (which touches everything) drowns out the signal
 * structure and the ordering degenerates to "arbitrary". This is a general
 * heuristic — it only reads `board.nets`, never a specific design's refdes or
 * the golden board.
 */

import type { BoardModel, Extents, Placement, PlacementConstraints, PlacementEngine, PlacedFootprint } from './types.js';

export const DEFAULT_PLACE_GAP_MM = 1.5;
export const DEFAULT_PLACE_MARGIN_MM = 1.0;

/** Footprint bounding box relative to its origin: courtyard when present, else
 * the pad extents (copper). */
export function footprintExtents(fp: PlacedFootprint): Extents {
  if (fp.courtyard) return fp.courtyard;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of fp.pads) {
    minX = Math.min(minX, p.x - p.width / 2);
    maxX = Math.max(maxX, p.x + p.width / 2);
    minY = Math.min(minY, p.y - p.height / 2);
    maxY = Math.max(maxY, p.y + p.height / 2);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/** Footprint bounding-box size (mm). */
export function footprintSize(fp: PlacedFootprint): { width: number; height: number } {
  const e = footprintExtents(fp);
  return { width: e.maxX - e.minX, height: e.maxY - e.minY };
}

/**
 * Order the board's footprints by schematic connectivity using a deterministic
 * Prim-style growth over an inverse-fanout-weighted net graph. Returns the same
 * footprint objects in the new order (callers pack them from this sequence).
 *
 * Ties (equal weight/degree) fall back to area-descending then ref-ascending, so
 * the result is stable for a given netlist and reproduces the original
 * area-descending order exactly when there is no connectivity at all.
 */
export function connectivityOrder(board: BoardModel): PlacedFootprint[] {
  const fps = board.footprints;
  const n = fps.length;
  if (n === 0) return [];

  const refToIdx = new Map<string, number>();
  fps.forEach((fp, i) => refToIdx.set(fp.ref, i));

  // Inverse-fanout-weighted adjacency: a net touching k components adds 1/(k-1)
  // between each pair, so 2-pin signal nets dominate global power rails.
  const weight = new Float64Array(n * n);
  for (const net of board.nets) {
    const refs: string[] = [];
    for (const pin of net.pins) {
      if (refToIdx.has(pin.ref) && !refs.includes(pin.ref)) refs.push(pin.ref);
    }
    if (refs.length < 2) continue;
    const w = 1 / (refs.length - 1);
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        const a = refToIdx.get(refs[i]!)!;
        const b = refToIdx.get(refs[j]!)!;
        weight[a * n + b] = weight[a * n + b]! + w;
        weight[b * n + a] = weight[b * n + a]! + w;
      }
    }
  }

  const degree = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) degree[i] = degree[i]! + weight[i * n + j]!;

  const area = fps.map((fp) => {
    const s = footprintSize(fp);
    return s.width * s.height;
  });
  // Strict total order for deterministic ties: area descending, then ref ascending.
  const before = (a: number, b: number): boolean => {
    if (area[a] !== area[b]) return area[a]! > area[b]!;
    return fps[a]!.ref < fps[b]!.ref;
  };

  const placed = new Array<boolean>(n).fill(false);
  const order: number[] = [];

  // Seed: the most-connected component (max degree), ties by area then ref.
  let seed = -1;
  for (let i = 0; i < n; i++) {
    if (seed < 0 || degree[i]! > degree[seed]! || (degree[i] === degree[seed] && before(i, seed))) seed = i;
  }
  order.push(seed);
  placed[seed] = true;

  // link[i] = total weight from i to everything already placed; updated
  // incrementally so each next pick is O(n).
  const link = new Float64Array(n);
  for (let i = 0; i < n; i++) link[i] = weight[seed * n + i]!;

  while (order.length < n) {
    // Pick the unplaced component most strongly linked to the growing cluster.
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      if (best < 0 || link[i]! > bestScore || (link[i] === bestScore && before(i, best))) {
        best = i;
        bestScore = link[i]!;
      }
    }
    // Disconnected from the cluster (no shared nets): start a new cluster from
    // the highest-degree remaining component.
    if (best < 0 || bestScore <= 0) {
      best = -1;
      for (let i = 0; i < n; i++) {
        if (placed[i]) continue;
        if (best < 0 || degree[i]! > degree[best]! || (degree[i] === degree[best] && before(i, best))) best = i;
      }
    }
    order.push(best);
    placed[best] = true;
    for (let i = 0; i < n; i++) link[i] = link[i]! + weight[best * n + i]!;
  }

  return order.map((i) => fps[i]!);
}

/**
 * Deterministic grid placement over a whole board: order by connectivity
 * ({@link connectivityOrder}) when the board carries nets, else area-descending
 * (tie-break by ref); pack left-to-right wrapping at a row width derived from
 * total area, then size the board to the placed courtyard bounding box. The
 * footprint origin is offset by the courtyard `minX`/`minY`, so copper always
 * lands inside the board edge (no copper-edge-clearance violation). Mutates
 * `board` footprints (`x`/`y`) and `board.width`/`height`.
 */
export function placeBoard(board: BoardModel, opts: { gap?: number; margin?: number } = {}): void {
  const gap = opts.gap ?? DEFAULT_PLACE_GAP_MM;
  const margin = opts.margin ?? DEFAULT_PLACE_MARGIN_MM;

  // Connectivity-aware ordering when the board carries nets; the pure
  // area-descending grid is the fallback for a net-less board (and for the
  // existing simple-board tests, which pass an empty `nets` array).
  const ordered = board.nets.length > 0 ? connectivityOrder(board) : [...board.footprints].sort(byAreaDesc);

  const totalArea = ordered.reduce((a, fp) => a + footprintSize(fp).width * footprintSize(fp).height, 0);
  const rowW = Math.max(25, Math.min(150, Math.sqrt(totalArea) * 2.5));

  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const fp of ordered) {
    const e = footprintExtents(fp);
    const w = e.maxX - e.minX;
    const h = e.maxY - e.minY;
    if (cx > 0 && cx + w > rowW) {
      cx = 0;
      cy += rowH + gap;
      rowH = 0;
    }
    fp.x = margin + cx - e.minX;
    fp.y = margin + cy - e.minY;
    cx += w + gap;
    rowH = Math.max(rowH, h);
  }

  let maxX = 0;
  let maxY = 0;
  for (const fp of board.footprints) {
    const e = footprintExtents(fp);
    maxX = Math.max(maxX, fp.x + e.maxX);
    maxY = Math.max(maxY, fp.y + e.maxY);
  }
  board.width = maxX + margin;
  board.height = maxY + margin;
}

/** Area-descending then ref-ascending — the pre-#141 ordering, kept as the
 * net-less fallback so a board with no connectivity places identically to before. */
function byAreaDesc(a: PlacedFootprint, b: PlacedFootprint): number {
  const sa = footprintSize(a);
  const sb = footprintSize(b);
  const area = sb.width * sb.height - sa.width * sa.height;
  return area !== 0 ? area : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}

/**
 * The first `PlacementEngine` — a deterministic, connectivity-aware packer. It
 * delegates to {@link placeBoard}; the class exists so the engine boundary has a
 * concrete in-repo implementation to test against.
 */
export class GridPlacementEngine implements PlacementEngine {
  async place(board: BoardModel, _constraints: PlacementConstraints): Promise<Placement> {
    placeBoard(board);
    return { footprints: board.footprints };
  }
}

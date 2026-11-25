/**
 * Free-space placement (add-reuse-placer, RFC 14 §8.4): where to put a part
 * the packer could not place.
 *
 * The vendored packer proposes positions only along the outline of what it has
 * already placed. That is a good heuristic on an empty board and a bad one on
 * a full one: past roughly half the board's area the free space is interior
 * pockets that the generator never offers, and parts come back unplaced with
 * every candidate rejected for overlap. This searches the whole board instead.
 *
 * The search is a grid over the outline, ordered by where the part's
 * connections want it — the weighted centroid of the pads it must reach — so
 * the first legal position found is usually also a short one. Legality is the
 * caller's predicate, which is the same courtyard test the checkers use, and
 * the best of the first few legal positions wins on true pad-to-pad cost.
 */
import type { ComponentInstance, Mdeg, PcbDesign, Point } from '../../ir/types.js';
import { bbox } from '../../ir/geometry.js';
import { moveComponent } from '../../ir/transform.js';
import { extentAt } from './transfer.js';

/** Pads already on the board, by net, with the weight their net carries. */
export interface PlacedPads {
  byNet: Map<string, Point[]>;
  weightOf: (netId: string) => number;
}

export interface FreeSpaceOptions {
  design: PcbDesign;
  component: ComponentInstance;
  /** Rotations to try, in millidegrees. */
  rotations: Mdeg[];
  /** The caller's legality test: inside the outline and clear of everything placed. */
  legal: (c: ComponentInstance, at: Point, rotation: Mdeg) => boolean;
  placed: PlacedPads;
  /** Grid step; chosen from the part's size when absent. */
  stepNm?: number;
  /** How many legal positions to score before settling (default 12). */
  scoreBest?: number;
}

/** At most this many grid points per rotation, so a big board stays quick. */
const MAX_POINTS_PER_ROTATION = 4000;

/** Never sample finer than this; below it the grid costs more than it finds. */
const MIN_STEP_NM = 250_000;

/** Legality tests one part may spend. A part with nowhere to go must not cost the run. */
const MAX_LEGALITY_TESTS = 30_000;

/** Where this part's connections want it: the weighted centroid of the pads it must reach. */
function idealPoint(c: ComponentInstance, placed: PlacedPads, fallback: Point): Point {
  let wx = 0, wy = 0, total = 0;
  for (const pad of c.pads) {
    if (!pad.netId) continue;
    const others = placed.byNet.get(pad.netId);
    if (!others?.length) continue;
    const w = placed.weightOf(pad.netId);
    if (w <= 0) continue;
    for (const p of others) {
      wx += p.x * w;
      wy += p.y * w;
      total += w;
    }
  }
  return total > 0 ? { x: Math.round(wx / total), y: Math.round(wy / total) } : fallback;
}

/** Pad-to-pad cost of a pose: every pad's distance to the nearest placed pad on its net, weighted. */
function poseCost(c: ComponentInstance, at: Point, rotation: Mdeg, placed: PlacedPads): number {
  const posed = moveComponent(c, { id: c.id, at, rotation, side: c.attributes.side });
  let cost = 0;
  for (const pad of posed.pads) {
    if (!pad.netId) continue;
    const others = placed.byNet.get(pad.netId);
    if (!others?.length) continue;
    const w = placed.weightOf(pad.netId);
    if (w <= 0) continue;
    let best = Number.POSITIVE_INFINITY;
    for (const p of others) best = Math.min(best, Math.hypot(pad.at.x - p.x, pad.at.y - p.y));
    if (Number.isFinite(best)) cost += best * w;
  }
  return cost;
}

/**
 * The best legal position for the part, or null when the board has none.
 * Deterministic: the grid, the ordering and the tie-breaks are all fixed.
 */
export function findFreeSpace(opts: FreeSpaceOptions): { at: Point; rotation: Mdeg; cost: number } | null {
  const { design, component: c, placed } = opts;
  const board = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm;
  const centre = { x: Math.round((board.minX + board.maxX) / 2), y: Math.round((board.minY + board.maxY) / 2) };
  const ideal = idealPoint(c, placed, centre);
  const scoreBest = opts.scoreBest ?? 12;

  /**
   * The grid is sized from the room the part has, never from the part itself: a
   * large part has few legal positions, so it needs a finer grid, not a coarser
   * one. Getting this backwards makes the search miss pockets that exist.
   */
  const gridFor = (divisor: number) => {
    const candidates: { at: Point; rotation: Mdeg; d: number }[] = [];
    for (const rotation of opts.rotations) {
      // the origin's range is what keeps the part's extent inside the outline
      const e = extentAt(c, { x: 0, y: 0 }, rotation);
      const minX = board.minX + inset - e.minX;
      const maxX = board.maxX - inset - e.maxX;
      const minY = board.minY + inset - e.minY;
      const maxY = board.maxY - inset - e.maxY;
      if (maxX < minX || maxY < minY) continue;
      const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
      const step = Math.max(MIN_STEP_NM, Math.round(Math.sqrt((spanX * spanY) / (MAX_POINTS_PER_ROTATION * divisor))));
      for (let x = minX; x <= maxX; x += step) {
        for (let y = minY; y <= maxY; y += step) {
          const at = { x: Math.round(x), y: Math.round(y) };
          candidates.push({ at, rotation, d: Math.hypot(at.x - ideal.x, at.y - ideal.y) });
        }
      }
      // the point the connections actually want, when it is in range
      const at = { x: Math.min(Math.max(ideal.x, minX), maxX), y: Math.min(Math.max(ideal.y, minY), maxY) };
      candidates.push({ at: { x: Math.round(at.x), y: Math.round(at.y) }, rotation, d: 0 });
    }
    // nearest to where the connections want it first, so the first legal position is usually a good one
    return candidates.sort((a, b) => a.d - b.d || a.rotation - b.rotation || a.at.x - b.at.x || a.at.y - b.at.y);
  };

  const scored: { at: Point; rotation: Mdeg; cost: number }[] = [];
  let tested = 0;
  // one coarse pass, then a finer one only when the coarse grid found nothing
  for (const divisor of opts.stepNm ? [1] : [1, 4]) {
    const candidates = gridFor(divisor);
    for (const cand of candidates) {
      if (tested >= MAX_LEGALITY_TESTS) break;
      tested++;
      if (!opts.legal(c, cand.at, cand.rotation)) continue;
      scored.push({ at: cand.at, rotation: cand.rotation, cost: poseCost(c, cand.at, cand.rotation, placed) });
      if (scored.length >= scoreBest) break;
    }
    if (scored.length || tested >= MAX_LEGALITY_TESTS) break;
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.cost - b.cost || a.rotation - b.rotation || a.at.x - b.at.x || a.at.y - b.at.y);
  return scored[0]!;
}

/** The pads already on the board, for the search's cost function. */
export function placedPadsOf(design: PcbDesign, positions: Map<string, { at: Point; rotation: Mdeg }>, skip: Set<string>, netWeights: Map<string, number>): PlacedPads {
  const byNet = new Map<string, Point[]>();
  for (const c of design.components) {
    if (skip.has(c.id)) continue;
    const pose = positions.get(c.id);
    const posed = pose ? moveComponent(c, { id: c.id, at: pose.at, rotation: pose.rotation, side: c.attributes.side }) : c;
    for (const pad of posed.pads) {
      if (!pad.netId) continue;
      (byNet.get(pad.netId) ?? byNet.set(pad.netId, []).get(pad.netId)!).push(pad.at);
    }
  }
  const nameOf = new Map(design.nets.map((n) => [n.id, n.name]));
  return { byNet, weightOf: (netId) => netWeights.get(nameOf.get(netId) ?? '') ?? 1 };
}

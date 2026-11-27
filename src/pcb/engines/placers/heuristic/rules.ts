/**
 * The rules a hardware engineer places a board by, before any optimiser runs.
 * Four of them, in the order they are applied, because each one fixes the
 * ground the next one stands on:
 *
 * 1. **a connector belongs on a board edge, facing out.** Which edge comes
 *    from the intent when it says; otherwise from the subsystem the connector
 *    serves, and failing that from spreading them. The orientation is the
 *    quarter turn that leaves the part's pads furthest inboard, which is the
 *    one whose mating face points off the board.
 * 2. **subsystems get territory before parts get positions.** Each subsystem
 *    is given a disc sized from the area its parts need, and the discs are
 *    laid out around the board centre, each pulled toward the edge its own
 *    connectors went to — which is what makes signals run edge to centre to
 *    edge rather than doubling back.
 * 3. **the main IC sits in the middle.** The board's largest anchor IC takes
 *    the centre, and its subsystem's disc is the one centred there.
 * 4. **inside a subsystem, the anchor IC is the centre and its passives ring
 *    it**, closest first in the order their relationships matter: decoupling,
 *    bootstrap, crystal, configuration, then the rest. Each part goes at the
 *    nearest legal grid position to the pads it must reach, so a decoupling
 *    cap lands beside the supply pin it serves rather than merely near the IC.
 *
 * This is not an optimiser: it searches no placement space and scores no
 * candidates against each other. It reads an intent — the same `PlacementPlan`
 * a model writes and the rules write without one — and applies the rules to
 * it, deterministically. Positions land on a grid because a board a person
 * would accept is a board whose parts line up.
 */
import type { ComponentInstance, Mdeg, PcbDesign, PlacedComponent, Point } from '../../../ir/types.js';
import { bbox, bboxOf, contains, intersects, type BBox, type Polygon } from '../../../ir/geometry.js';
import { normMdeg } from '../../../ir/units.js';
import { moveComponent } from '../../../ir/transform.js';
import { EDGE_ORDER, wantsBoardEdge, type BoardEdge } from '../../../intent/blocks.js';
import { CLASS_WEIGHT, PHASE_ORDER, partKind, type Classification, type CriticalClass } from '../../../intent/critical.js';
import type { PlacementPlan } from '../../reuse/plan.js';
import { poseOutline, extentAt, ROTATIONS } from '../../reuse/transfer.js';
import { occupiesBothSides } from '../../reuse/compile.js';
import { findFreeSpace, placedPadsOf } from '../../reuse/freespace.js';

export interface HeuristicOptions {
  design: PcbDesign;
  /** The intent: subsystems, their anchors, connector edges, critical relationships, phase order. */
  plan: PlacementPlan;
  classification: Classification;
  /** Reference designators this run may move. */
  movableRefs: string[];
  /** Positions snap to this grid (default 0.5 mm): parts that line up read as placed, not scattered. */
  gridNm?: number;
  /** Area a subsystem's disc gets over the sum of its parts' extents (default 2.6). */
  slack?: number;
  log?: (line: string) => void;
}

export interface HeuristicResult {
  placements: PlacedComponent[];
  unplacedIds: string[];
  /** What each rule did, in the order it ran. */
  notes: string[];
}

const GRID_NM = 500_000;
const EDGE_GAP_NM = 600_000;
const SUBSYSTEM_GAP_NM = 1_500_000;
const DEFAULT_SLACK = 2.6;
/** How far back from the edge a connector may step when the outline leaves no room flush against it. */
const INWARD_STEPS = 8;
/** Legal positions to score on a ring before settling on the cheapest. */
const SETTLE = 6;

/** How near the anchor a class of part belongs, smallest first: the ring order inside a subsystem. */
const RING_ORDER: CriticalClass[] = ['supply-decoupling', 'bootstrap', 'crystal', 'config', 'hot-loop', 'output-chain', 'sensitive', 'signal', 'channel', 'thermal', 'aggressor', 'low', 'mechanical', 'rf-keepout'];

const PASSIVE = new Set(['cap', 'res', 'ind', 'diode', 'led', 'jumper', 'testpoint']);

/** A part's own extent: its courtyard, else the box its copper needs. */
function extentPoly(c: ComponentInstance): Polygon {
  if (c.footprint.courtyard) return c.footprint.courtyard;
  const b = c.pads.length ? bboxOf(c.pads.map((p) => p.copper)) : { minX: c.at.x, minY: c.at.y, maxX: c.at.x, maxY: c.at.y };
  return { outer: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], holes: [] };
}

function partArea(c: ComponentInstance): number {
  const b = bbox(extentPoly(c));
  return Math.max(1, (b.maxX - b.minX) * (b.maxY - b.minY));
}

/** Unit vector pointing off the board at each edge (KiCad y grows downward, so north is the smaller y). */
const OUTWARD: Record<BoardEdge, Point> = { north: { x: 0, y: -1 }, south: { x: 0, y: 1 }, west: { x: -1, y: 0 }, east: { x: 1, y: 0 } };

export function placeByRules(opts: HeuristicOptions): HeuristicResult {
  const { design, plan, classification } = opts;
  const log = opts.log ?? (() => {});
  const grid = Math.max(1, opts.gridNm ?? GRID_NM);
  const slack = opts.slack ?? DEFAULT_SLACK;
  const notes: string[] = [];

  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const movable = new Set(opts.movableRefs.filter((r) => byRef.has(r) && !byRef.get(r)!.attributes.locked));
  const board = bbox(design.board.outline);
  // the band `legalizeEdge` enforces after every placer: a position that ignores
  // it is shoved inward at materialise time, and the shove is what makes overlaps
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  const limit: BBox = { minX: board.minX + inset, minY: board.minY + inset, maxX: board.maxX - inset, maxY: board.maxY - inset };
  const centre: Point = { x: Math.round((board.minX + board.maxX) / 2), y: Math.round((board.minY + board.maxY) / 2) };
  const snap = (v: number) => Math.round(v / grid) * grid;

  // ---- the board as it stands: everything this run may not move is an obstacle from the start
  const placed = new Map<string, PlacedComponent>();
  const obstacles: { id: string; poly: Polygon; box: BBox; side: 'front' | 'back'; both: boolean }[] = [];
  const padsByNet = new Map<string, Point[]>();
  const netNameOf = new Map(design.nets.map((n) => [n.id, n.name]));
  const weightOf = (netId: string) => classification.netWeights.get(netNameOf.get(netId) ?? '') ?? 1;

  const addPads = (c: ComponentInstance, at: Point, rotation: Mdeg) => {
    for (const pad of moveComponent(c, { id: c.id, at, rotation, side: c.attributes.side }).pads) {
      if (!pad.netId) continue;
      (padsByNet.get(pad.netId) ?? padsByNet.set(pad.netId, []).get(pad.netId)!).push(pad.at);
    }
  };
  const addObstacle = (c: ComponentInstance, at: Point, rotation: Mdeg) => {
    const poly = poseOutline(c, at, rotation);
    obstacles.push({ id: c.id, poly, box: bbox(poly), side: c.attributes.side, both: occupiesBothSides(c) });
  };
  for (const c of design.components) {
    if (movable.has(c.reference)) continue;
    addObstacle(c, c.at, c.rotation);
    addPads(c, c.at, c.rotation);
  }

  const legal = (c: ComponentInstance, at: Point, rotation: Mdeg): boolean => {
    const poly = poseOutline(c, at, rotation);
    if (!poly.outer.every((p) => contains(design.board.outline, p))) return false;
    const box = bbox(poly);
    if (box.minX < limit.minX || box.minY < limit.minY || box.maxX > limit.maxX || box.maxY > limit.maxY) return false;
    const both = occupiesBothSides(c);
    for (const other of obstacles) {
      if (other.id === c.id) continue;
      // the other side is another board as far as courtyards go, unless a part goes through
      if (other.side !== c.attributes.side && !other.both && !both) continue;
      if (box.minX >= other.box.maxX || box.maxX <= other.box.minX || box.minY >= other.box.maxY || box.maxY <= other.box.minY) continue;
      if (intersects(poly, other.poly)) return false;
    }
    return true;
  };

  const commit = (c: ComponentInstance, at: Point, rotation: Mdeg) => {
    placed.set(c.id, { id: c.id, at, rotation, side: c.attributes.side });
    addObstacle(c, at, rotation);
    addPads(c, at, rotation);
  };

  /** What a pose costs: every pad's distance to the nearest pad already on its net, weighted by the net. */
  const poseCost = (c: ComponentInstance, at: Point, rotation: Mdeg): number => {
    let cost = 0;
    for (const pad of moveComponent(c, { id: c.id, at, rotation, side: c.attributes.side }).pads) {
      if (!pad.netId) continue;
      const others = padsByNet.get(pad.netId);
      if (!others?.length) continue;
      const w = weightOf(pad.netId);
      if (w <= 0) continue;
      let best = Number.POSITIVE_INFINITY;
      for (const p of others) best = Math.min(best, Math.hypot(pad.at.x - p.x, pad.at.y - p.y));
      if (Number.isFinite(best)) cost += best * w;
    }
    return cost;
  };

  /** The anchor's own pins that this part shares a net with, as one point; null when it touches none of them. */
  const atAnchorPins = (c: ComponentInstance, anchor: ComponentInstance): Point | null => {
    const pose = placed.get(anchor.id);
    if (!pose) return null;
    const posed = moveComponent(anchor, pose);
    const nets = new Set(c.pads.map((p) => p.netId).filter((n): n is string => !!n));
    const hits = posed.pads.filter((p) => p.netId && nets.has(p.netId) && weightOf(p.netId) > 0);
    if (!hits.length) return null;
    // a ground-only or rail-only connection says nothing about where the part goes;
    // the net weights already discount those, so weight the pins by their nets
    let wx = 0, wy = 0, total = 0;
    for (const p of hits) {
      const w = weightOf(p.netId!);
      wx += p.at.x * w;
      wy += p.at.y * w;
      total += w;
    }
    return total > 0 ? { x: Math.round(wx / total), y: Math.round(wy / total) } : null;
  };

  /** Where this part's connections want it: the weighted centroid of the pads it must reach. */
  const wantedAt = (c: ComponentInstance): Point | null => {
    let wx = 0, wy = 0, total = 0;
    for (const pad of c.pads) {
      if (!pad.netId) continue;
      const others = padsByNet.get(pad.netId);
      if (!others?.length) continue;
      const w = weightOf(pad.netId);
      if (w <= 0) continue;
      for (const p of others) {
        wx += p.x * w;
        wy += p.y * w;
        total += w;
      }
    }
    return total > 0 ? { x: Math.round(wx / total), y: Math.round(wy / total) } : null;
  };

  const planned = new Map(plan.orientation.map((o) => [o.ref, normMdeg(Math.round(o.rotation_deg) * 1000)]));
  const rotationsFor = (c: ComponentInstance): Mdeg[] => {
    const fixed = planned.get(c.reference);
    if (fixed !== undefined) return [fixed];
    return ROTATIONS.map((r) => normMdeg(c.rotation + r));
  };

  /**
   * The nearest legal position to `target`, searched outward ring by ring on
   * the grid. The first ring that offers enough legal positions wins, and the
   * cheapest of those is taken: near beats short, which is the whole point of
   * clustering a subsystem rather than minimising wire length over the board.
   */
  const spotNear = (c: ComponentInstance, target: Point, radiusLimitNm: number): { at: Point; rotation: Mdeg } | null => {
    const rotations = rotationsFor(c);
    // how hard this part is pulled to its target: the weight of its most important net
    const pull = Math.max(1, ...c.pads.map((p) => (p.netId ? weightOf(p.netId) : 0)));
    const found: { at: Point; rotation: Mdeg; cost: number }[] = [];
    for (let r = 0; r <= radiusLimitNm; r += grid) {
      const steps = r === 0 ? 1 : Math.max(8, Math.min(72, Math.round((2 * Math.PI * r) / grid)));
      const seen = new Set<string>();
      for (let k = 0; k < steps; k++) {
        const a = (2 * Math.PI * k) / steps;
        const at = { x: snap(target.x + r * Math.cos(a)), y: snap(target.y + r * Math.sin(a)) };
        const key = `${at.x},${at.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const rotation of rotations) {
          if (!legal(c, at, rotation)) continue;
          // Pad-to-pad cost alone puts a decoupling cap beside another cap on the
          // same rail rather than at the pin it serves — every pad on the net is
          // as good as the right one. The pull toward the target is what makes
          // the rule "at that pin" instead of "somewhere on that net".
          found.push({ at, rotation, cost: poseCost(c, at, rotation) + pull * Math.hypot(at.x - target.x, at.y - target.y) });
        }
      }
      if (found.length >= SETTLE) break;
    }
    if (!found.length) return null;
    found.sort((a, b) => a.cost - b.cost || a.rotation - b.rotation || a.at.x - b.at.x || a.at.y - b.at.y);
    return { at: found[0]!.at, rotation: found[0]!.rotation };
  };

  /** Last resort: the whole board, ordered by where the part's connections want it. */
  const anywhere = (c: ComponentInstance): { at: Point; rotation: Mdeg } | null => {
    const poses = new Map([...placed].map(([id, p]) => [id, { at: p.at, rotation: p.rotation }]));
    const pending = new Set(design.components.filter((x) => movable.has(x.reference) && !placed.has(x.id)).map((x) => x.id));
    const found = findFreeSpace({ design, component: c, rotations: rotationsFor(c), legal, placed: placedPadsOf(design, poses, pending, classification.netWeights) });
    if (!found) return null;
    // the search answered off the grid; take the grid only when it is still legal there,
    // because snapping after the test is what silently puts two courtyards on top of each other
    const snapped = { x: snap(found.at.x), y: snap(found.at.y) };
    return { at: legal(c, snapped, found.rotation) ? snapped : found.at, rotation: found.rotation };
  };

  const put = (c: ComponentInstance, target: Point, radiusNm: number): boolean => {
    const spot = spotNear(c, target, radiusNm) ?? anywhere(c);
    if (!spot) {
      const e = bbox(extentPoly(c));
      log(`heuristic: ${c.reference} (${((e.maxX - e.minX) / 1e6).toFixed(1)} x ${((e.maxY - e.minY) / 1e6).toFixed(1)} mm) has no legal position left on the board`);
      return false;
    }
    commit(c, spot.at, spot.rotation);
    return true;
  };

  // ---- rule 1: connectors go to a board edge, facing out
  const subsystemOf = new Map<string, string>();
  for (const s of plan.subsystems) for (const m of s.members) subsystemOf.set(m, s.id);
  const regionCentre = (id: string | null | undefined): Point | null => {
    const r = id ? plan.regions.find((x) => x.id === id) : undefined;
    return r ? { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) } : null;
  };
  const plannedEdge = new Map<string, BoardEdge>();
  for (const f of plan.fixed) if (f.edge && EDGE_ORDER.includes(f.edge as BoardEdge)) plannedEdge.set(f.ref, f.edge as BoardEdge);

  const edgeRefs = [...movable].filter((r) => wantsBoardEdge(byRef.get(r)!)).sort();
  // how much edge each one needs, and how much each edge has: a board's edges
  // are a budget, and a run that ignores it stacks six receptacles on the side
  // one subsystem happened to sit nearest and leaves three edges empty
  const spanOf: Record<BoardEdge, number> = { north: limit.maxX - limit.minX, south: limit.maxX - limit.minX, west: limit.maxY - limit.minY, east: limit.maxY - limit.minY };
  const used: Record<BoardEdge, number> = { south: 0, north: 0, west: 0, east: 0 };
  const widthOf = (ref: string) => {
    const b = bbox(extentPoly(byRef.get(ref)!));
    return Math.max(b.maxX - b.minX, b.maxY - b.minY) + EDGE_GAP_NM;
  };
  const edgeAssignment = new Map<string, BoardEdge>();
  for (const ref of edgeRefs) {
    const width = widthOf(ref);
    const fromPlan = plannedEdge.get(ref);
    if (fromPlan) {
      edgeAssignment.set(ref, fromPlan);
      used[fromPlan] += width;
      continue;
    }
    // no intent for this one: the edge its own subsystem's region is nearest, and
    // the next-nearest when that one is full
    const sub = plan.subsystems.find((s) => s.id === subsystemOf.get(ref));
    const from = regionCentre(sub?.region) ?? centre;
    const gap: Record<BoardEdge, number> = { south: board.maxY - from.y, north: from.y - board.minY, west: from.x - board.minX, east: board.maxX - from.x };
    const preference = [...EDGE_ORDER].sort((p, q) => gap[p] - gap[q] || used[p] - used[q] || EDGE_ORDER.indexOf(p) - EDGE_ORDER.indexOf(q));
    const edge = preference.find((e) => used[e] + width <= spanOf[e]) ?? preference.sort((p, q) => spanOf[q] - used[q] - (spanOf[p] - used[p]))[0]!;
    edgeAssignment.set(ref, edge);
    used[edge] += width;
  }

  /** The quarter turn that leaves the part's pads furthest inboard: its mating face then points off the board. */
  const outwardRotation = (c: ComponentInstance, edge: BoardEdge): Mdeg => {
    const fixed = planned.get(c.reference);
    if (fixed !== undefined) return fixed;
    const out = OUTWARD[edge];
    const along = edge === 'north' || edge === 'south' ? 'x' : 'y';
    const scored = rotationsFor(c).map((rotation) => {
      const posed = moveComponent(c, { id: c.id, at: { x: 0, y: 0 }, rotation, side: c.attributes.side });
      const pads = posed.pads.length ? posed.pads : [];
      const cx = pads.reduce((a, p) => a + p.at.x, 0) / Math.max(1, pads.length);
      const cy = pads.reduce((a, p) => a + p.at.y, 0) / Math.max(1, pads.length);
      const e = extentAt(c, { x: 0, y: 0 }, rotation);
      const span = along === 'x' ? e.maxX - e.minX : e.maxY - e.minY;
      const depth = along === 'x' ? e.maxY - e.minY : e.maxX - e.minX;
      // a connector lies along its edge and reaches as little way into the board as
      // it can; of the two poses that do that, the one whose pads point inboard is
      // the one whose mating face points off the board
      return { rotation, inward: -(cx * out.x + cy * out.y), lying: span - depth };
    });
    scored.sort((a, b) => b.lying - a.lying || b.inward - a.inward || a.rotation - b.rotation);
    return scored[0]!.rotation;
  };

  /** Slide the part along `edge` from where it is wanted until it is legal; the extent sits flush against the clearance band. */
  const placeOnEdge = (c: ComponentInstance, edge: BoardEdge, wantedAlong: number | null): boolean => {
    const rotation = outwardRotation(c, edge);
    const e = extentAt(c, { x: 0, y: 0 }, rotation);
    const along = edge === 'north' || edge === 'south' ? 'x' : 'y';
    const across =
      edge === 'north' ? limit.minY - e.minY
      : edge === 'south' ? limit.maxY - e.maxY
      : edge === 'west' ? limit.minX - e.minX
      : limit.maxX - e.maxX;
    const lo = along === 'x' ? limit.minX : limit.minY;
    const hi = along === 'x' ? limit.maxX : limit.maxY;
    const start = wantedAlong ?? (lo + hi) / 2 - (along === 'x' ? (e.minX + e.maxX) / 2 : (e.minY + e.maxY) / 2);
    // Flush first, then a little further in. An outline is not always a rectangle
    // — a rounded end, a taper or a notch leaves no room at the bounding box's
    // edge — and a connector 1 mm inboard is still a connector on the edge.
    const inward = OUTWARD[edge];
    for (let back = 0; back <= INWARD_STEPS; back++) {
      for (let step = 0; step <= Math.ceil((hi - lo) / grid); step++) {
        for (const dir of step === 0 ? [0] : [1, -1]) {
          const a = snap(start + dir * step * grid);
          const off = back * grid;
          const at = along === 'x' ? { x: a, y: Math.round(across - inward.y * off) } : { x: Math.round(across - inward.x * off), y: a };
          if (!legal(c, at, rotation)) continue;
          commit(c, at, rotation);
          return true;
        }
      }
    }
    return false;
  };

  for (const edge of EDGE_ORDER) {
    const refs = edgeRefs.filter((r) => edgeAssignment.get(r) === edge).sort((a, b) => (subsystemOf.get(a) ?? '~').localeCompare(subsystemOf.get(b) ?? '~') || a.localeCompare(b));
    if (!refs.length) continue;
    const along = edge === 'north' || edge === 'south' ? 'x' : 'y';
    const poses = refs.map((ref) => {
      const c = byRef.get(ref)!;
      const rotation = outwardRotation(c, edge);
      const e = extentAt(c, { x: 0, y: 0 }, rotation);
      return { c, e, width: along === 'x' ? e.maxX - e.minX : e.maxY - e.minY };
    });
    // the group is laid out along the edge as one run, centred, each part in refdes order
    const total = poses.reduce((a, p) => a + p.width, 0) + EDGE_GAP_NM * (poses.length - 1);
    const lo = along === 'x' ? limit.minX : limit.minY;
    const hi = along === 'x' ? limit.maxX : limit.maxY;
    let cursor = Math.max(lo, (lo + hi) / 2 - total / 2);
    for (const p of poses) {
      const wanted = cursor + p.width / 2 - (along === 'x' ? (p.e.minX + p.e.maxX) / 2 : (p.e.minY + p.e.maxY) / 2);
      cursor += p.width + EDGE_GAP_NM;
      placeOnEdge(p.c, edge, wanted);
    }
    notes.push(`${refs.filter((r) => placed.has(byRef.get(r)!.id)).length}/${refs.length} part(s) on the ${edge} edge, facing out`);
  }
  // a connector its own edge had no room for belongs on another edge, not mid-board
  for (const ref of edgeRefs) {
    const c = byRef.get(ref)!;
    if (placed.has(c.id)) continue;
    const others = [...EDGE_ORDER].filter((e) => e !== edgeAssignment.get(ref)).sort((p, q) => spanOf[q] - used[q] - (spanOf[p] - used[p]) || EDGE_ORDER.indexOf(p) - EDGE_ORDER.indexOf(q));
    const moved = others.find((e) => placeOnEdge(c, e, null));
    if (moved) notes.push(`${ref} moved to the ${moved} edge; its own had no room left`);
  }

  // ---- rules 2 and 3: subsystems get discs, the main IC's subsystem takes the centre
  interface Slot { id: string; centre: Point; radius: number; members: string[]; anchor: string | null }
  const anchorRefs = new Set(plan.subsystems.map((s) => s.anchor).filter((a): a is string => !!a));
  const pending = (refs: string[]) => refs.filter((r) => movable.has(r) && !placed.has(byRef.get(r)!.id));
  const slots: Slot[] = plan.subsystems
    .map((s) => {
      const members = pending(s.members);
      const area = members.reduce((a, r) => a + partArea(byRef.get(r)!), 0);
      return { id: s.id, centre, radius: Math.round(Math.sqrt((area * slack) / Math.PI)), members, anchor: s.anchor && members.includes(s.anchor) ? s.anchor : null };
    })
    .filter((s) => s.members.length > 0);

  // the main IC: the largest anchor on the board, and the centre is its
  const padsOf = (r: string) => byRef.get(r)?.pads.length ?? 0;
  const mainSlot = [...slots].sort((a, b) => padsOf(b.anchor ?? '') - padsOf(a.anchor ?? '') || b.members.length - a.members.length || a.id.localeCompare(b.id))[0] ?? null;
  const placedSlots: Slot[] = [];
  if (mainSlot) {
    mainSlot.centre = { x: snap(centre.x), y: snap(centre.y) };
    placedSlots.push(mainSlot);
    notes.push(`${mainSlot.anchor ?? mainSlot.id} at the board centre with its ${mainSlot.members.length} part(s) around it`);
  }
  const rest = slots.filter((s) => s !== mainSlot).sort((a, b) => b.radius - a.radius || a.id.localeCompare(b.id));
  for (const slot of rest) {
    // the direction its own connectors went: a subsystem belongs between its edge and the centre
    const pulls = slot.members.map((r) => placed.get(byRef.get(r)!.id)).filter((p): p is PlacedComponent => !!p);
    const pull = pulls.length
      ? { x: pulls.reduce((a, p) => a + p.at.x, 0) / pulls.length - centre.x, y: pulls.reduce((a, p) => a + p.at.y, 0) / pulls.length - centre.y }
      : null;
    const base = pull && Math.hypot(pull.x, pull.y) > grid ? Math.atan2(pull.y, pull.x) : (2 * Math.PI * placedSlots.length) / Math.max(1, slots.length);
    const want = (mainSlot?.radius ?? 0) + slot.radius + SUBSYSTEM_GAP_NM;
    let best: { at: Point; clash: number } | null = null;
    for (let turn = 0; turn <= 12; turn++) {
      for (const dir of turn === 0 ? [0] : [1, -1]) {
        const a = base + dir * turn * (Math.PI / 12);
        for (const r of [want, want * 0.8, want * 0.6]) {
          const at = {
            x: snap(Math.min(Math.max(centre.x + r * Math.cos(a), limit.minX + slot.radius), limit.maxX - slot.radius)),
            y: snap(Math.min(Math.max(centre.y + r * Math.sin(a), limit.minY + slot.radius), limit.maxY - slot.radius)),
          };
          const clash = placedSlots.reduce((acc, o) => acc + Math.max(0, o.radius + slot.radius - Math.hypot(at.x - o.centre.x, at.y - o.centre.y)), 0);
          if (!best || clash < best.clash) best = { at, clash };
          if (clash === 0) break;
        }
        if (best?.clash === 0) break;
      }
      if (best?.clash === 0) break;
    }
    slot.centre = best ? best.at : { x: snap(centre.x), y: snap(centre.y) };
    placedSlots.push(slot);
  }
  if (placedSlots.length > 1) notes.push(`${placedSlots.length} subsystem(s) given territory around the centre`);

  // ---- rule 4: inside a subsystem, the anchor first, then its parts ringed around it
  const phaseRank = new Map<string, number>();
  plan.phases.forEach((p) => p.parts.forEach((r) => phaseRank.set(r, PHASE_ORDER.indexOf(p.kind))));
  const ringRank = (ref: string): number => {
    const classes = classification.partClasses.get(ref) ?? new Set<CriticalClass>();
    let best = RING_ORDER.length;
    for (const cls of classes) best = Math.min(best, RING_ORDER.indexOf(cls) < 0 ? RING_ORDER.length : RING_ORDER.indexOf(cls));
    return best;
  };
  const weightRank = (ref: string): number => {
    const classes = classification.partClasses.get(ref) ?? new Set<CriticalClass>();
    return Math.max(0, ...[...classes].map((c) => CLASS_WEIGHT[c] ?? 0));
  };

  /**
   * The part each support part is tied to, from the strongest critical
   * relationship it takes part in: a decoupling cap belongs at the pin of the
   * IC it decouples, even when the partition put the two in different
   * subsystems — which is what happens to every bulk cap on a shared rail.
   */
  const partnerOf = new Map<string, string>();
  for (const rel of plan.critical) {
    const weight = CLASS_WEIGHT[rel.class] ?? 0;
    if (weight <= 1) continue; // signal, low, mechanical: no relationship worth moving a part for
    const candidates = rel.refs.filter((r) => byRef.has(r));
    // the IC of the relationship: an anchor if it names one, else the part with the most pads
    const partner = candidates.filter((r) => classification.ics.has(r)).sort((a, b) => padsOf(b) - padsOf(a) || a.localeCompare(b))[0]
      ?? candidates.sort((a, b) => padsOf(b) - padsOf(a) || a.localeCompare(b))[0];
    if (!partner) continue;
    for (const r of candidates) {
      if (r === partner) continue;
      const held = partnerOf.get(r);
      if (held && (CLASS_WEIGHT[(plan.critical.find((x) => x.refs.includes(r) && x.refs.includes(held))?.class ?? 'low')] ?? 0) >= weight) continue;
      partnerOf.set(r, partner);
    }
  }

  const unplacedIds: string[] = [];
  for (const slot of placedSlots) {
    const anchor = slot.anchor ? byRef.get(slot.anchor) : undefined;
    if (anchor && !placed.has(anchor.id)) {
      if (!put(anchor, slot.centre, Math.max(slot.radius, 4 * grid))) unplacedIds.push(anchor.id);
    }
    // closest relationships first; an IC that is not the anchor before the passives that hang off it
    const members = pending(slot.members).sort((a, b) => {
      const ca = byRef.get(a)!, cb = byRef.get(b)!;
      return (phaseRank.get(a) ?? PHASE_ORDER.length) - (phaseRank.get(b) ?? PHASE_ORDER.length)
        || ringRank(a) - ringRank(b)
        || weightRank(b) - weightRank(a)
        || Number(PASSIVE.has(partKind(ca))) - Number(PASSIVE.has(partKind(cb)))
        || cb.pads.length - ca.pads.length
        || a.localeCompare(b);
    });
    const anchorPlaced = anchor && placed.has(anchor.id) ? anchor : null;
    for (const ref of members) {
      const c = byRef.get(ref)!;
      if (placed.has(c.id)) continue;
      // Rule 4 proper: a part goes at the pins of the IC it serves — the partner
      // of its strongest critical relationship, else its subsystem's anchor.
      // Without this a decoupling cap drifts toward whatever was placed first,
      // usually the connector on the edge, and the cluster never forms.
      const partner = partnerOf.get(ref);
      const partnerPose = partner && byRef.has(partner) && placed.has(byRef.get(partner)!.id) ? byRef.get(partner)! : null;
      const atPartner = partnerPose ? atAnchorPins(c, partnerPose) : null;
      const atAnchor = anchorPlaced ? atAnchorPins(c, anchorPlaced) : null;
      // a relationship reaches across subsystems, so its target is taken as it is;
      // the looser targets are kept inside the subsystem's own territory
      const loose = atAnchor ?? wantedAt(c) ?? slot.centre;
      const target = atPartner ?? (Math.hypot(loose.x - slot.centre.x, loose.y - slot.centre.y) <= slot.radius * 1.5 ? loose : slot.centre);
      if (!put(c, target, Math.max(slot.radius * 1.5, 6 * grid))) unplacedIds.push(c.id);
    }
    notes.push(`${slot.id}: ${slot.members.filter((r) => placed.has(byRef.get(r)!.id)).length}/${slot.members.length} part(s) placed around ${slot.anchor ?? 'its centre'}`);
  }

  // ---- whatever the intent put in no subsystem: mounting holes, test points, strays
  const leftovers = [...movable].filter((r) => !placed.has(byRef.get(r)!.id) && !unplacedIds.includes(byRef.get(r)!.id)).sort();
  for (const ref of leftovers) {
    const c = byRef.get(ref)!;
    const target = wantedAt(c) ?? centre;
    if (!put(c, target, Math.max(...placedSlots.map((s) => s.radius), 8 * grid))) unplacedIds.push(c.id);
  }
  if (leftovers.length) notes.push(`${leftovers.filter((r) => placed.has(byRef.get(r)!.id)).length}/${leftovers.length} part(s) outside every subsystem placed near their connections`);

  for (const n of notes) log(`heuristic: ${n}`);
  const anchorsPlaced = [...anchorRefs].filter((r) => byRef.has(r) && placed.has(byRef.get(r)!.id)).length;
  if (anchorsPlaced) log(`heuristic: ${anchorsPlaced} anchor IC(s) at the centre of their subsystem`);
  return { placements: [...placed.values()].filter((p) => movable.has(design.components.find((c) => c.id === p.id)!.reference)), unplacedIds, notes };
}

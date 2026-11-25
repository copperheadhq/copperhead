/**
 * Phases (add-reuse-placer, RFC 14 §8.4): the order a hardware engineer builds
 * a board in, run as one packer solve each. Mechanical parts first, then the
 * anchor ICs in their regions, then the support parts their datasheets tie to
 * them, then the current loops, then what separation demands, then the rest.
 *
 * Each phase packs only its own parts; everything placed so far goes in as
 * static, and everything a later phase will place is left out entirely, so a
 * part waiting its turn never blocks the board it has not been placed on yet.
 *
 * Three placements do not come from the packer, and say so in the report:
 *
 * - **mechanical parts follow the plan.** A connector belongs where the
 *   board's mechanics put it. Packing it would also usually fail: the packer
 *   anchors candidates to the outline of what it has already placed, which
 *   cannot fit a part nearly as wide as the board.
 * - **a part the packer rejects falls back to its planned position**, when that
 *   position is inside the outline and clear of everything placed.
 * - **failing that, the board is searched for free space.** The packer's
 *   candidates hug the outline of what it has already placed, so past roughly
 *   half full it cannot see the interior pockets that remain; the search can,
 *   and orders them by where the part's connections want it. Only when that
 *   also finds nothing is the part reported unplaced.
 */
import type { PcbDesign, ComponentInstance, PlacedComponent, Point, Mdeg } from '../../ir/types.js';
import { bbox, contains, intersects } from '../../ir/geometry.js';
import type { Polygon } from '../../ir/geometry.js';
import { normMdeg } from '../../ir/units.js';
import type { Classification } from '../../intent/critical.js';
import { PHASE_ORDER, type PhaseKind } from '../../intent/critical.js';
import type { PlacementPlan } from './plan.js';
import { compilePhase, decodePacked, occupiesBothSides } from './compile.js';
import { poseOutline } from './transfer.js';
import { findFreeSpace, placedPadsOf } from './freespace.js';
import { packComponents, type FacadeResult } from '../../../vendor/calculate-packing/facade.js';

export interface PhaseReport {
  kind: PhaseKind;
  placed: string[];
  /** Parts placed at the position the plan gave, not by the packer. */
  fromPlan: string[];
  /** Parts the packer could not place, put in free space by the search instead. */
  fromSearch: string[];
  unplaced: { ref: string; why: string }[];
  iterations: number;
  seconds: number;
}

export interface RunPhasesOptions {
  design: PcbDesign;
  plan: PlacementPlan;
  classification: Classification;
  /** Reference designators this run may move. */
  movableRefs: string[];
  /** Where the plan wants each part (transferred positions), by refdes. */
  targets?: Map<string, Point>;
  /**
   * Take the planned position outright wherever it is still legal, and pack
   * only the parts that cannot keep it (default true when there are targets).
   * This is what reuse means: a board that changed in one corner keeps the
   * reference everywhere else. Setting it false repacks the whole board, which
   * is the right variant when the outline or the part set changed a lot.
   */
  planFirst?: boolean;
  /**
   * Search the board for free space when the packer cannot place a part
   * (default true). The packer only proposes positions along the outline of
   * what it has already placed, which runs out of answers on a board past
   * roughly half full; the search sees interior space too.
   */
  freeSpace?: boolean;
  attraction?: number;
  inflationNm?: number;
  /** Rotations a part may take when the plan fixes none. */
  rotations?: number[];
  log?: (line: string) => void;
}

export interface PhasesResult {
  placements: PlacedComponent[];
  unplacedIds: string[];
  phases: PhaseReport[];
}

/** Run every phase of the plan in order, each on top of the last. */
export function runPhases(opts: RunPhasesOptions): PhasesResult {
  const { design, plan } = opts;
  const log = opts.log ?? (() => {});
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const idOfRef = new Map(design.components.map((c) => [c.reference, c.id]));
  const movable = new Set(opts.movableRefs);
  const planned = new Map(plan.orientation.map((o) => [o.ref, normMdeg(Math.round(o.rotation_deg) * 1000)]));
  const placed: PlacedComponent[] = [];
  const phases: PhaseReport[] = [];
  const unplacedIds: string[] = [];
  const ordered = [...plan.phases].sort((a, b) => PHASE_ORDER.indexOf(a.kind) - PHASE_ORDER.indexOf(b.kind));
  const awaiting = new Set(ordered.flatMap((p) => p.parts).filter((r) => movable.has(r)).map((r) => idOfRef.get(r)).filter((id): id is string => !!id));

  const rotationOf = (c: ComponentInstance) => planned.get(c.reference) ?? c.rotation;
  const quarterTurns = (opts.rotations ?? [0, 90, 180, 270]).map((d) => normMdeg(Math.round(d) * 1000));
  // a part whose orientation the plan fixed keeps it; otherwise the search may turn it
  const rotationsFor = (c: ComponentInstance): Mdeg[] => {
    const fixed = planned.get(c.reference);
    return fixed !== undefined && fixed % 90_000 === 0 ? [fixed] : quarterTurns;
  };
  /**
   * Everything already on the board, as polygons with their bounding boxes.
   * The free-space search tests thousands of positions against this set, so it
   * is built once per change rather than re-derived per candidate: recomputing
   * every other part's courtyard on every candidate is what made the search
   * cost tens of seconds on a dense board.
   */
  let obstacles: { id: string; poly: Polygon; box: ReturnType<typeof bbox>; side: 'front' | 'back'; both: boolean }[] = [];
  let obstacleKey = '';
  const refreshObstacles = () => {
    const key = `${placed.length}:${awaiting.size}`;
    if (key === obstacleKey) return;
    obstacleKey = key;
    obstacles = [];
    for (const other of design.components) {
      if (awaiting.has(other.id)) continue;
      const p = placed.find((x) => x.id === other.id);
      if (!p && movable.has(other.reference)) continue;
      const poly = poseOutline(other, p?.at ?? other.at, p?.rotation ?? other.rotation);
      obstacles.push({ id: other.id, poly, box: bbox(poly), side: other.attributes.side, both: occupiesBothSides(other) });
    }
  };

  const legal = (c: ComponentInstance, at: Point, rotation: Mdeg): boolean => {
    const poly = poseOutline(c, at, rotation);
    if (!poly.outer.every((p) => contains(design.board.outline, p))) return false;
    // the same band `legalizeEdge` enforces later: a placement that ignores it is
    // shoved inward at materialise time, and the shove is what creates overlaps
    const eb = bbox(poly);
    if (eb.minX < edgeLimit.minX || eb.minY < edgeLimit.minY || eb.maxX > edgeLimit.maxX || eb.maxY > edgeLimit.maxY) return false;
    refreshObstacles();
    const box = bbox(poly);
    const bothSides = occupiesBothSides(c);
    // everything already on the board: the parts this run has placed and the parts it cannot move.
    // courtyards may touch, as they do on a dense designer board; the rule is overlap.
    for (const other of obstacles) {
      if (other.id === c.id) continue;
      // the other side is another board as far as courtyards go, unless a part goes through
      if (other.side !== c.attributes.side && !other.both && !bothSides) continue;
      // boxes first: a cheap rejection for the overwhelming majority of pairs
      if (box.minX >= other.box.maxX || box.maxX <= other.box.minX || box.minY >= other.box.maxY || box.maxY <= other.box.minY) continue;
      if (intersects(poly, other.poly)) return false;
    }
    return true;
  };

  // the least move that brings a part back inside the outline, when the plan's
  // position no longer fits: the outline is the thing that changed, so a part
  // hanging over the new edge belongs just inside it, not repacked elsewhere
  const outlineBox = bbox(design.board.outline);
  // `legalizeEdge` uses the copper-to-edge clearance plus 250 um; match it exactly
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  const edgeLimit = { minX: outlineBox.minX + inset, minY: outlineBox.minY + inset, maxX: outlineBox.maxX - inset, maxY: outlineBox.maxY - inset };
  const clampInside = (c: ComponentInstance, at: Point, rotation: Mdeg): Point | null => {
    const b = bbox(poseOutline(c, at, rotation));
    const lim = { minX: outlineBox.minX + inset, minY: outlineBox.minY + inset, maxX: outlineBox.maxX - inset, maxY: outlineBox.maxY - inset };
    let dx = 0, dy = 0;
    if (b.minX < lim.minX) dx = lim.minX - b.minX;
    else if (b.maxX > lim.maxX) dx = lim.maxX - b.maxX;
    if (b.minY < lim.minY) dy = lim.minY - b.minY;
    else if (b.maxY > lim.maxY) dy = lim.maxY - b.maxY;
    if (!dx && !dy) return null;
    const moved = { x: Math.round(at.x + dx), y: Math.round(at.y + dy) };
    return legal(c, moved, rotation) ? moved : null;
  };

  for (const phase of ordered) {
    const t0 = Date.now();
    let refs = [...new Set(phase.parts.filter((r) => movable.has(r) && idOfRef.has(r)))];
    if (!refs.length) continue;
    const fromPlan: string[] = [];

    // the plan's positions first: mechanical parts outright, the rest where they are still legal
    const planFirst = opts.planFirst ?? true;
    if (opts.targets?.size && (planFirst || phase.kind === 'mechanical')) {
      const done = new Set<string>();
      for (const r of refs) {
        const c = byRef.get(r);
        const at = opts.targets.get(r);
        if (!c || !at) continue;
        const rotation = rotationOf(c);
        // a mechanical part whose position the outline no longer holds is moved just inside it
        const where = legal(c, at, rotation) ? at : phase.kind === 'mechanical' ? clampInside(c, at, rotation) : null;
        if (!where) continue;
        placed.push({ id: c.id, at: where, rotation, side: c.attributes.side });
        awaiting.delete(c.id);
        done.add(r);
        fromPlan.push(r);
      }
      refs = refs.filter((r) => !done.has(r));
    }

    let iterations = 0;
    let failure: string | null = null;
    const why = new Map<string, string>();
    const placeIds = refs.map((r) => idOfRef.get(r)!);
    // one solve per side: parts on the back do not compete with parts on the front
    for (const side of ['front', 'back'] as const) {
      const sideRefs = refs.filter((r) => byRef.get(r)!.attributes.side === side);
      if (!sideRefs.length) continue;
      const sideIds = sideRefs.map((r) => idOfRef.get(r)!);
      for (const id of sideIds) awaiting.delete(id);
      const compiled = compilePhase({
        design,
        plan,
        classification: opts.classification,
        placeIds: sideIds,
        placed,
        pendingIds: [...awaiting],
        side,
        ...(opts.targets ? { targets: opts.targets } : {}),
        ...(opts.attraction !== undefined ? { attraction: opts.attraction } : {}),
        ...(opts.inflationNm !== undefined ? { inflationNm: opts.inflationNm } : {}),
        ...(opts.rotations ? { rotations: opts.rotations } : {}),
      });
      try {
        const result: FacadeResult = packComponents(compiled.input);
        iterations += result.iterations;
        for (const u of result.unplaced) why.set(u.id, `${u.closestRejection}: ${u.message}`);
        placed.push(...decodePacked(result.placements, compiled.idOf, design, new Set(sideIds)));
      } catch (e) {
        failure = (e as Error).message;
        log(`phase ${phase.kind} (${side}): packer failed (${failure})`);
      }
    }

    // a part the packer could not place still has a planned position; take it when it is legal
    const placedIds = new Set(placed.map((p) => p.id));
    const unplaced: { ref: string; why: string }[] = [];
    const fromSearch: string[] = [];
    for (const id of placeIds) {
      if (placedIds.has(id)) continue;
      const c = byId.get(id)!;
      const at = opts.targets?.get(c.reference);
      const rotation = rotationOf(c);
      const where = at ? (legal(c, at, rotation) ? at : clampInside(c, at, rotation)) : null;
      if (where) {
        placed.push({ id, at: where, rotation, side: c.attributes.side });
        placedIds.add(id);
        fromPlan.push(c.reference);
        continue;
      }
      if (opts.freeSpace !== false) {
        const poses = new Map(placed.map((p) => [p.id, { at: p.at, rotation: p.rotation }]));
        const found = findFreeSpace({
          design,
          component: c,
          rotations: rotationsFor(c),
          legal,
          placed: placedPadsOf(design, poses, new Set([...awaiting, c.id]), opts.classification.netWeights),
        });
        if (found) {
          placed.push({ id, at: found.at, rotation: found.rotation, side: c.attributes.side });
          placedIds.add(id);
          fromSearch.push(c.reference);
          continue;
        }
      }
      unplacedIds.push(id);
      unplaced.push({ ref: c.reference, why: failure ?? why.get(c.reference) ?? 'the packer returned no position' });
    }

    const report: PhaseReport = {
      kind: phase.kind,
      placed: placed.filter((p) => placeIds.includes(p.id) || fromPlan.includes(byId.get(p.id)?.reference ?? '') || fromSearch.includes(byId.get(p.id)?.reference ?? '')).map((p) => byId.get(p.id)?.reference ?? p.id).sort(),
      fromPlan: [...new Set(fromPlan)].sort(),
      fromSearch: [...new Set(fromSearch)].sort(),
      unplaced,
      iterations,
      seconds: (Date.now() - t0) / 1000,
    };
    phases.push(report);
    log(`phase ${phase.kind}: placed ${report.placed.length}/${report.placed.length + unplaced.length}${report.fromPlan.length ? ` (${report.fromPlan.length} from the plan)` : ''}${report.fromSearch.length ? ` (${report.fromSearch.length} from a free-space search)` : ''} in ${report.seconds.toFixed(2)} s`);
    for (const u of unplaced) log(`phase ${phase.kind}: ${u.ref} unplaced (${u.why})`);
  }
  return { placements: placed, unplacedIds, phases };
}

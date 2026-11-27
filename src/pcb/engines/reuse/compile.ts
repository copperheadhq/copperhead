/**
 * Compile a plan into packer input (add-reuse-placer, RFC 14 §8.3). The plan
 * says what belongs where; this turns it into the only things the packer
 * understands — static parts, a boundary, obstacles, per-network weights, and
 * a pack order — so that no coordinate in the result was chosen by a model.
 *
 * Four translations do the work:
 *
 * - **static parts**: everything already placed (fixed, locked, earlier phases)
 *   goes in as a static component the packer must not move but must avoid.
 * - **point attractors**: where the plan wants a part (its transferred
 *   position, else its region centre) becomes a one-pad static component on a
 *   private network, and the part gets a matching pad. The packer's cost is
 *   distance to same-network pads, so the part is pulled there without any
 *   coordinate being imposed.
 * - **class weights**: a critical relationship's networks weigh more, so the
 *   packer buys their length first (decoupling 6, hot loop 8, signal 1,
 *   power 0.25, ground 0).
 * - **inflation**: the courtyard a part packs with is its own, grown by the
 *   board's clearance, so `minGap` stays the one number the packer needs.
 *
 * Units: the packer works in millimetres with y up; the IR is nanometres with
 * y down, as KiCad writes it. Every conversion is here, and `decodePacked`
 * puts the result back.
 */
import type { PcbDesign, ComponentInstance, PlacedComponent, Point } from '../../ir/types.js';
import { bbox, bboxOf, rotatePoint } from '../../ir/geometry.js';
import { normMdeg } from '../../ir/units.js';
import type { Classification } from '../../intent/critical.js';
import type { PlacementPlan } from './plan.js';
import { planTarget } from './plan.js';
import type { FacadeComponent, FacadeInput, FacadeObstacle, FacadePad, FacadePlacement } from '../../../vendor/calculate-packing/facade.js';

const NM = 1e6;
const mm = (nm: number) => Number((nm / NM).toFixed(4));
const nm = (v: number) => Math.round(v * NM);

/** Board point (nanometres, y down) to packer point (millimetres, y up). */
export const toPack = (p: Point): { x: number; y: number } => ({ x: mm(p.x), y: mm(-p.y) });
/** Packer point back to board coordinates. */
export const fromPack = (p: { x: number; y: number }): Point => ({ x: nm(p.x), y: -nm(p.y) });

/** The prefix of the private networks the attractors use; nothing else may use it. */
export const ATTRACTOR_NET = '__copperhead_attract__';

export interface CompileOptions {
  design: PcbDesign;
  plan: PlacementPlan;
  classification: Classification;
  /** Component ids this phase places. */
  placeIds: string[];
  /** Positions already decided: fixed parts and the parts earlier phases placed. */
  placed: PlacedComponent[];
  /**
   * Parts a later phase will place. They are left out of the input entirely:
   * a part waiting its turn has no position yet, and passing the one it happens
   * to sit at (a parked row below the outline, say) would block the board.
   */
  pendingIds?: string[];
  /**
   * The side being packed. Parts on the other side do not compete for room,
   * so only same-side parts (and through-hole parts, which take both sides)
   * are passed as static. Omitted means one problem for the whole board.
   */
  side?: 'front' | 'back';
  /** Where the plan wants each movable part, by refdes. */
  targets?: Map<string, Point>;
  /** Strength of the pull toward a target, as a network weight. Zero switches attractors off. */
  attraction?: number;
  /** Extra gap beyond the board's clearance, in nanometres. */
  inflationNm?: number;
  /** Rotations a part may take, when the plan does not fix one. */
  rotations?: number[];
}

/** A through-hole part takes room on both sides; a surface part only on its own. */
export function occupiesBothSides(c: ComponentInstance): boolean {
  return c.attributes.throughHole || c.pads.some((p) => p.type === 'thru_hole' || p.type === 'np_thru_hole');
}

/** A part's local frame: the pad and courtyard offsets it has at rotation zero. */
function local(c: ComponentInstance, p: Point): Point {
  return rotatePoint({ x: p.x - c.at.x, y: p.y - c.at.y }, -c.rotation);
}

function padsOf(c: ComponentInstance, netName: Map<string, string>): FacadePad[] {
  // a footprint may repeat a pad number (a thermal pad, a split ground pad), so the
  // packer's pad id carries the ordinal too: it only has to be unique and stable
  return c.pads.filter((p) => p.layers.length || p.netId).map((p, i) => {
    const o = local(c, p.at);
    const b = bboxOf([p.copper]);
    // the pad's size in its own frame; a rotated pad packs as the box that holds it
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    const turned = Math.round(normMdeg(p.rotation - c.rotation) / 1000) % 180 === 90;
    return {
      id: `${c.reference}.${p.number || '-'}#${i}`,
      network: p.netId ? netName.get(p.netId) ?? p.netId : `__nc__${c.reference}.${p.number}#${i}`,
      x: mm(o.x),
      y: mm(-o.y),
      w: mm(turned ? h : w),
      h: mm(turned ? w : h),
    };
  });
}

function boxOf(c: ComponentInstance, inflationNm: number): FacadeComponent['box'] {
  const polys = c.footprint.courtyard ? [c.footprint.courtyard] : c.pads.map((p) => p.copper);
  if (!polys.length) return { x: 0, y: 0, w: mm(inflationNm || NM), h: mm(inflationNm || NM) };
  const b = bboxOf(polys);
  const centre = local(c, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  const turned = Math.round(normMdeg(c.rotation) / 1000) % 180 === 90;
  const w = b.maxX - b.minX + inflationNm, h = b.maxY - b.minY + inflationNm;
  return { x: mm(centre.x), y: mm(-centre.y), w: mm(turned ? h : w), h: mm(turned ? w : h) };
}

export interface CompiledPhase {
  input: FacadeInput;
  /** Packer component id (the refdes) to IR component id. */
  idOf: Map<string, string>;
  /** Attractor components added, for the report. */
  attractors: string[];
}

export function compilePhase(opts: CompileOptions): CompiledPhase {
  const { design, plan, classification } = opts;
  const netName = new Map(design.nets.map((n) => [n.id, n.name]));
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const placeIds = new Set(opts.placeIds);
  const placedAt = new Map(opts.placed.map((p) => [p.id, p]));
  // The box carries the clearance as well as `minGap`, which leaves about twice the
  // gap the rules demand. That is deliberate: measured on the benchmark, dropping it
  // to zero packs parts so tightly that later parts have nowhere legal to go, and
  // three boards that placed legally stopped doing so.
  const inflation = opts.inflationNm ?? design.board.rules.clearanceNm;
  const attraction = opts.attraction ?? 3;
  const rotations = opts.rotations ?? [0, 90, 180, 270];
  const fixedRotation = new Map(plan.orientation.map((o) => [o.ref, ((o.rotation_deg % 360) + 360) % 360]));

  const components: FacadeComponent[] = [];
  const idOf = new Map<string, string>();
  const attractors: string[] = [];
  const order: string[] = [];

  // static: the parts this phase must work around
  const pending = new Set(opts.pendingIds ?? []);
  for (const c of design.components) {
    if (placeIds.has(c.id) || pending.has(c.id)) continue;
    if (opts.side && c.attributes.side !== opts.side && !occupiesBothSides(c)) continue;
    const p = placedAt.get(c.id);
    const at = p?.at ?? c.at;
    const rotation = p?.rotation ?? c.rotation;
    const centre = toPack(at);
    components.push({
      id: c.reference,
      pads: padsOf(c, netName),
      box: boxOf(c, inflation),
      rotations: [Math.round(normMdeg(rotation) / 1000) % 360],
      fixed: { x: centre.x, y: centre.y, rotation: Math.round(normMdeg(rotation) / 1000) % 360 },
    });
    idOf.set(c.reference, c.id);
  }

  // movable: this phase's parts, in the plan's order, each with its attractor
  const phaseOrder = plan.phases.flatMap((ph) => ph.parts);
  const movable = [...placeIds].map((id) => byId.get(id)).filter((c): c is ComponentInstance => !!c)
    .sort((a, b) => {
      const ia = phaseOrder.indexOf(a.reference), ib = phaseOrder.indexOf(b.reference);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.reference.localeCompare(b.reference);
    });
  for (const c of movable) {
    const pads = padsOf(c, netName);
    // the packer rotates a movable part in quarter turns only; a plan that asks for
    // another angle gets the full set back, and the legalizer keeps the part legal
    const planned = fixedRotation.get(c.reference);
    const fixedRot = planned !== undefined && planned % 90 === 0 ? planned : undefined;
    const target = opts.targets ? planTarget(plan, c.reference, opts.targets) : null;
    if (target && attraction > 0) {
      const net = `${ATTRACTOR_NET}${c.reference}`;
      pads.push({ id: `${c.reference}.__attract`, network: net, x: 0, y: 0, w: 0.01, h: 0.01 });
      const t = toPack(target);
      components.push({ id: `__attract__${c.reference}`, pads: [{ id: `__attract__${c.reference}.1`, network: net, x: 0, y: 0, w: 0.01, h: 0.01 }], box: { x: 0, y: 0, w: 0.01, h: 0.01 }, rotations: [0], fixed: { x: t.x, y: t.y, rotation: 0 } });
      attractors.push(c.reference);
    }
    components.push({
      id: c.reference,
      pads,
      box: boxOf(c, inflation),
      rotations: fixedRot !== undefined ? [fixedRot] : rotations,
    });
    idOf.set(c.reference, c.id);
    order.push(c.reference);
  }

  const obstacles: FacadeObstacle[] = [];
  for (const cut of design.board.cutouts) {
    const b = bbox(cut);
    const c = toPack({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    obstacles.push({ x: c.x, y: c.y, w: mm(b.maxX - b.minX), h: mm(b.maxY - b.minY) });
  }
  for (const k of design.board.keepouts) {
    if (!k.prohibits.includes('footprints') && !k.prohibits.includes('copper')) continue;
    const b = bbox(k.polygon);
    const c = toPack({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    obstacles.push({ x: c.x, y: c.y, w: mm(b.maxX - b.minX), h: mm(b.maxY - b.minY) });
  }

  const networkWeights: Record<string, number> = {};
  for (const [name, w] of classification.netWeights) networkWeights[name] = w;
  for (const ref of attractors) networkWeights[`${ATTRACTOR_NET}${ref}`] = attraction;

  const boundary = design.board.outline.outer.map(toPack);
  return {
    input: {
      components,
      obstacles,
      boundary,
      minGap: mm(design.board.rules.clearanceNm),
      networkWeights,
      order,
      strategy: 'minimum_sum_squared_distance_to_network',
    },
    idOf,
    attractors,
  };
}

/** Packer placements back into IR placements; attractors and static parts are dropped. */
export function decodePacked(placements: FacadePlacement[], idOf: Map<string, string>, design: PcbDesign, placeIds: Set<string>): PlacedComponent[] {
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const out: PlacedComponent[] = [];
  for (const p of placements) {
    const id = idOf.get(p.id);
    if (!id || !placeIds.has(id)) continue;
    const c = byId.get(id);
    if (!c) continue;
    out.push({ id, at: fromPack({ x: p.x, y: p.y }), rotation: normMdeg(Math.round(p.rotation) * 1000), side: c.attributes.side });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

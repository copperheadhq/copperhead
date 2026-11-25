/**
 * The placement plan (add-reuse-placer, RFC 14 §8.1): what a hardware engineer
 * decides before moving anything — which parts belong together, where each
 * group sits, which relationships are critical, and the order the board gets
 * built in. It is data, never coordinates for every part: the packer computes
 * those. A model writes one; `defaultPlan` writes the same shape from the
 * reference board and the rules, so the placer runs with no model at all.
 *
 * Validation is strict and total: a plan that names a part that is not on the
 * board, puts a part in two subsystems, or leaves a movable part out of every
 * phase is refused with the reason, never repaired silently.
 */
import type { PcbDesign, PlacedComponent, Point } from '../../ir/types.js';
import { bbox } from '../../ir/geometry.js';
import { normMdeg } from '../../ir/units.js';
import type { Partition } from '../../intent/subsystems.js';
import { PHASE_ORDER, phaseOf, type Classification, type CriticalClass, type CriticalRelation, type PhaseKind } from '../../intent/critical.js';

export const PLAN_SCHEMA = 'copperhead-placement-plan/1' as const;

export interface PlanRegion {
  id: string;
  /** Board coordinates, nanometres, y as KiCad writes it. */
  x: number;
  y: number;
  w: number;
  h: number;
  why?: string;
}

export interface PlanSubsystem {
  id: string;
  /** Reference designators. */
  members: string[];
  anchor: string | null;
  region: string | null;
  /** Where the subsystem's signal enters and leaves, for the region planner's reading. */
  flow?: string;
}

export interface PlanFixed {
  ref: string;
  x_mm?: number;
  y_mm?: number;
  rotation_deg?: number;
  edge?: 'north' | 'south' | 'east' | 'west';
  why?: string;
}

export interface PlanOrientation {
  ref: string;
  rotation_deg: number;
  why?: string;
}

export interface PlanCritical {
  class: CriticalClass;
  refs: string[];
  pins?: string[];
  order?: string[];
  against?: string[];
  kind?: 'switching' | 'supply' | 'output';
  max_mm?: number;
  min_mm?: number;
  max_area_mm2?: number;
  why?: string;
}

export interface PlanPhase {
  kind: PhaseKind;
  /** Reference designators placed in this phase, in the order they are packed. */
  parts: string[];
  note?: string;
}

export interface PlacementPlan {
  schema: typeof PLAN_SCHEMA;
  strategy: 'reuse' | 'fresh';
  reference?: { board: string; coverage: number; transform?: { rotation_deg: number; dx_mm: number; dy_mm: number } };
  regions: PlanRegion[];
  subsystems: PlanSubsystem[];
  fixed: PlanFixed[];
  orientation: PlanOrientation[];
  critical: PlanCritical[];
  phases: PlanPhase[];
  notes: string[];
}

export interface PlanValidation {
  errors: string[];
  warnings: string[];
}

const CRITICAL_CLASSES = new Set<string>(['mechanical', 'rf-keepout', 'supply-decoupling', 'bootstrap', 'config', 'crystal', 'hot-loop', 'output-chain', 'aggressor', 'sensitive', 'channel', 'thermal', 'signal', 'low']);

/** Check a plan against the board it is for. `movableRefs` are the parts the run may move. */
export function validatePlan(plan: PlacementPlan, design: PcbDesign, movableRefs: string[]): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const refs = new Set(design.components.map((c) => c.reference));
  const movable = new Set(movableRefs);
  const known = (where: string, list: string[]) => {
    for (const r of list) if (!refs.has(r)) errors.push(`${where}: ${r} is not on the board`);
  };
  if (plan.schema !== PLAN_SCHEMA) errors.push(`schema must be ${PLAN_SCHEMA}`);
  const board = bbox(design.board.outline);
  const regionIds = new Set<string>();
  for (const r of plan.regions) {
    if (regionIds.has(r.id)) errors.push(`regions: ${r.id} is declared twice`);
    regionIds.add(r.id);
    if (r.w <= 0 || r.h <= 0) errors.push(`regions.${r.id}: width and height must be positive`);
    if (r.x < board.minX - 1 || r.y < board.minY - 1 || r.x + r.w > board.maxX + 1 || r.y + r.h > board.maxY + 1) warnings.push(`regions.${r.id} extends past the board outline; it is clipped`);
  }
  const owner = new Map<string, string>();
  for (const s of plan.subsystems) {
    known(`subsystems.${s.id}`, s.members);
    if (s.anchor && !refs.has(s.anchor)) errors.push(`subsystems.${s.id}: anchor ${s.anchor} is not on the board`);
    if (s.anchor && !s.members.includes(s.anchor)) errors.push(`subsystems.${s.id}: anchor ${s.anchor} is not one of its members`);
    if (s.region && !regionIds.has(s.region)) errors.push(`subsystems.${s.id}: region ${s.region} is not declared`);
    for (const m of s.members) {
      const held = owner.get(m);
      if (held) errors.push(`subsystems: ${m} is in both ${held} and ${s.id}`);
      else owner.set(m, s.id);
    }
  }
  for (const f of plan.fixed) {
    known('fixed', [f.ref]);
    if (f.x_mm === undefined !== (f.y_mm === undefined)) errors.push(`fixed.${f.ref}: needs both x_mm and y_mm, or neither`);
    if (f.x_mm === undefined && !f.edge) errors.push(`fixed.${f.ref}: needs a position or an edge`);
    if (f.rotation_deg !== undefined && f.rotation_deg % 90 !== 0) warnings.push(`fixed.${f.ref}: rotation ${f.rotation_deg}° is not a multiple of 90°`);
  }
  for (const o of plan.orientation) {
    known('orientation', [o.ref]);
    if (o.rotation_deg % 90 !== 0) warnings.push(`orientation.${o.ref}: rotation ${o.rotation_deg}° is not a multiple of 90°`);
  }
  for (const c of plan.critical) {
    if (!CRITICAL_CLASSES.has(c.class)) errors.push(`critical: ${c.class} is not a class this release knows`);
    known(`critical.${c.class}`, [...c.refs, ...(c.order ?? []), ...(c.against ?? [])]);
    if (!c.refs.length) errors.push(`critical.${c.class}: needs at least one part`);
    for (const p of c.pins ?? []) {
      const [ref, pad] = p.split('.');
      const comp = design.components.find((x) => x.reference === ref);
      if (!comp) errors.push(`critical.${c.class}: pin ${p} names no part`);
      else if (pad && !comp.pads.some((x) => x.number === pad)) errors.push(`critical.${c.class}: ${ref} has no pad ${pad}`);
    }
  }
  const phased = new Set<string>();
  const seenPhase = new Set<string>();
  for (const p of plan.phases) {
    if (!PHASE_ORDER.includes(p.kind)) errors.push(`phases: ${p.kind} is not a phase this release knows`);
    if (seenPhase.has(p.kind)) errors.push(`phases: ${p.kind} appears twice`);
    seenPhase.add(p.kind);
    known(`phases.${p.kind}`, p.parts);
    for (const r of p.parts) {
      if (phased.has(r)) errors.push(`phases: ${r} is placed in two phases`);
      phased.add(r);
      if (!movable.has(r)) warnings.push(`phases.${p.kind}: ${r} is not movable in this run; it keeps its position`);
    }
  }
  const order = plan.phases.map((p) => PHASE_ORDER.indexOf(p.kind));
  if (order.some((v, i) => i > 0 && v < order[i - 1]!)) errors.push(`phases: out of order; they run ${PHASE_ORDER.join(' -> ')}`);
  for (const r of movableRefs) if (!phased.has(r)) errors.push(`phases: ${r} is movable but in no phase`);
  return { errors, warnings };
}

export interface DefaultPlanInput {
  design: PcbDesign;
  movableRefs: string[];
  partition: Partition;
  classification: Classification;
  /** Positions transferred from a reference, when there is one: regions follow them. */
  transferred?: PlacedComponent[];
  reference?: { board: string; coverage: number; transform?: { rotation_deg: number; dx_mm: number; dy_mm: number } };
  /** Parts that keep a position the run must not change (locked, user-fixed). */
  fixedRefs?: string[];
  /** Margin around a region derived from transferred positions. */
  regionMarginNm?: number;
}

const toMm = (nm: number) => Number((nm / 1e6).toFixed(3));

/**
 * The plan the placer uses when no model wrote one: subsystems from the chosen
 * partition, regions from where the reference put each subsystem (or a grid
 * over the outline when there is no reference), critical relationships from the
 * rules, and the engineer's phase order.
 */
export function defaultPlan(input: DefaultPlanInput): PlacementPlan {
  const { design, partition, classification } = input;
  const refOf = new Map(design.components.map((c) => [c.id, c.reference]));
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const movable = new Set(input.movableRefs);
  const fixedRefs = new Set(input.fixedRefs ?? design.components.filter((c) => c.attributes.locked).map((c) => c.reference));
  const margin = input.regionMarginNm ?? 1_000_000;
  const board = bbox(design.board.outline);
  const at = new Map<string, Point>();
  for (const p of input.transferred ?? []) {
    const r = refOf.get(p.id);
    if (r) at.set(r, p.at);
  }
  for (const c of design.components) if (!at.has(c.reference) && !movable.has(c.reference)) at.set(c.reference, c.at);

  const subsystems: PlanSubsystem[] = [];
  const regions: PlanRegion[] = [];
  const placedSubsystems = partition.subsystems.filter((s) => s.members.length >= 2);
  const gridCols = Math.max(1, Math.ceil(Math.sqrt(placedSubsystems.length || 1)));
  placedSubsystems.forEach((s, i) => {
    const members = [...new Set(s.members.map((id) => refOf.get(id)).filter((r): r is string => !!r))].sort();
    const known = members.map((r) => at.get(r)).filter((p): p is Point => !!p);
    let region: PlanRegion;
    if (known.length >= 2) {
      const minX = Math.min(...known.map((p) => p.x)) - margin, maxX = Math.max(...known.map((p) => p.x)) + margin;
      const minY = Math.min(...known.map((p) => p.y)) - margin, maxY = Math.max(...known.map((p) => p.y)) + margin;
      region = { id: s.id, x: Math.max(board.minX, minX), y: Math.max(board.minY, minY), w: Math.min(board.maxX, maxX) - Math.max(board.minX, minX), h: Math.min(board.maxY, maxY) - Math.max(board.minY, minY), why: 'where the reference put this subsystem' };
    } else {
      // no reference: a grid cell, so the subsystems at least start apart
      const rows = Math.ceil(placedSubsystems.length / gridCols);
      const w = (board.maxX - board.minX) / gridCols, h = (board.maxY - board.minY) / rows;
      region = { id: s.id, x: Math.round(board.minX + (i % gridCols) * w), y: Math.round(board.minY + Math.floor(i / gridCols) * h), w: Math.round(w), h: Math.round(h), why: 'a share of the outline; no reference position' };
    }
    regions.push(region);
    subsystems.push({ id: s.id, members, anchor: s.anchor ? refOf.get(s.anchor) ?? null : null, region: region.id });
  });

  const critical: PlanCritical[] = classification.relations.map((r: CriticalRelation) => ({
    class: r.class,
    refs: r.refs,
    ...(r.pins ? { pins: r.pins } : {}),
    ...(r.order ? { order: r.order } : {}),
    ...(r.against ? { against: r.against } : {}),
    ...(r.kind ? { kind: r.kind } : {}),
    ...(r.maxMm !== undefined ? { max_mm: r.maxMm } : {}),
    ...(r.minMm !== undefined ? { min_mm: r.minMm } : {}),
    ...(r.maxLoopAreaMm2 !== undefined ? { max_area_mm2: r.maxLoopAreaMm2 } : {}),
    ...(r.cite ? { why: r.cite } : {}),
  }));

  const anchors = new Set(subsystems.map((s) => s.anchor).filter((a): a is string => !!a));
  const phases: PlanPhase[] = [];
  for (const kind of PHASE_ORDER) {
    if (kind === 'regions') continue;
    const parts = input.movableRefs.filter((r) => phaseOf(r, classification, anchors) === kind).sort((a, b) => {
      // inside a phase: anchors first, then the parts with the most pads (they constrain the rest)
      const ca = byRef.get(a)!, cb = byRef.get(b)!;
      return Number(anchors.has(b)) - Number(anchors.has(a)) || cb.pads.length - ca.pads.length || a.localeCompare(b);
    });
    if (parts.length) phases.push({ kind, parts });
  }

  const fixed: PlanFixed[] = [...fixedRefs].sort().map((ref) => {
    const c = byRef.get(ref);
    return c ? { ref, x_mm: toMm(c.at.x), y_mm: toMm(c.at.y), rotation_deg: normMdeg(c.rotation) / 1000, why: c.attributes.locked ? 'locked on the board' : 'fixed for this run' } : { ref, why: 'fixed for this run' };
  });

  const orientation: PlanOrientation[] = (input.transferred ?? [])
    .map((p) => ({ ref: refOf.get(p.id) ?? '', rotation_deg: normMdeg(p.rotation) / 1000 }))
    .filter((o) => o.ref && movable.has(o.ref))
    .map((o) => ({ ...o, why: 'as the reference has it' }))
    .sort((a, b) => a.ref.localeCompare(b.ref));

  return {
    schema: PLAN_SCHEMA,
    strategy: input.transferred?.length ? 'reuse' : 'fresh',
    ...(input.reference ? { reference: input.reference } : {}),
    regions,
    subsystems,
    fixed,
    orientation,
    critical,
    phases,
    notes: [`subsystems from the ${partition.key} partition`, `${classification.relations.length} critical relationships from the rules`],
  };
}

/** Where the plan wants a part to start: its transferred position, else its subsystem's region centre. */
export function planTarget(plan: PlacementPlan, ref: string, transferred: Map<string, Point>): Point | null {
  const t = transferred.get(ref);
  if (t) return t;
  const sub = plan.subsystems.find((s) => s.members.includes(ref));
  const region = sub?.region ? plan.regions.find((r) => r.id === sub.region) : undefined;
  return region ? { x: Math.round(region.x + region.w / 2), y: Math.round(region.y + region.h / 2) } : null;
}

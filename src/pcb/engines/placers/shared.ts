/**
 * What every placer wrapper needs: which components move, which stay, and
 * how to turn an engine's output board back into a PlacementResult without
 * trusting anything but the positions it wrote.
 */
import type { PcbDesign, ComponentInstance, Nm, Mdeg } from '../../ir/types.js';
import { rotatePoint } from '../../ir/geometry.js';
import { normMdeg } from '../../ir/units.js';
import type { PlacementJob, PlacementResult } from '../contracts.js';
import type { PlacedComponent } from '../../ir/types.js';

export function movable(job: PlacementJob): ComponentInstance[] {
  const design = job.snapshot.design;
  const ids = new Set(job.movableComponentIds);
  return design.components.filter((c) => ids.has(c.id) && !c.attributes.locked);
}

export function fixedRefs(job: PlacementJob): string[] {
  const moving = new Set(movable(job).map((c) => c.id));
  return job.snapshot.design.components.filter((c) => !moving.has(c.id)).map((c) => c.reference);
}

/** Placements for the movable components as they stand in `output`, matched by refdes (engines rewrite files; uuids are not trusted). */
export function placementsFrom(job: PlacementJob, output: PcbDesign): { placements: PlacedComponent[]; unplaced: string[]; moved: number } {
  const byRef = new Map(output.components.map((c) => [c.reference, c]));
  const placements: PlacedComponent[] = [];
  const unplaced: string[] = [];
  let moved = 0;
  for (const c of movable(job)) {
    const o = byRef.get(c.reference);
    if (!o) {
      unplaced.push(c.id);
      continue;
    }
    if (o.at.x !== c.at.x || o.at.y !== c.at.y || o.rotation !== c.rotation) moved++;
    placements.push({ id: c.id, at: { x: o.at.x, y: o.at.y }, rotation: o.rotation, side: o.attributes.side });
  }
  return { placements, unplaced, moved };
}

export function identityPlacements(job: PlacementJob): PlacedComponent[] {
  return movable(job).map((c) => ({ id: c.id, at: { x: c.at.x, y: c.at.y }, rotation: c.rotation, side: c.attributes.side }));
}

export function resultShape(status: PlacementResult['status'], placements: PlacedComponent[], unplaced: string[], wall: number, provenance: PlacementResult['provenance']): PlacementResult {
  return { status, placements, unplacedComponentIds: unplaced, diagnostics: [], runtime: { wallSeconds: wall, engineSeconds: wall }, provenance };
}

/** A block to reuse: member offsets relative to the anchor, in the anchor's frame. */
export interface LayoutBlockSpec {
  id: string;
  /** Target refdes of the anchor. */
  anchor: string;
  members: { ref: string; rel: { x: Nm; y: Nm; rotation: Mdeg }; side: 'front' | 'back' }[];
  source: string;
}

/** Specs travel in the job's constraints as `{ kind: 'layout.reuse', spec }`. */
export function specsOf(job: PlacementJob): LayoutBlockSpec[] {
  return job.constraints.filter((c): c is { kind: string; spec: LayoutBlockSpec } => typeof c === 'object' && c !== null && (c as { kind?: string }).kind === 'layout.reuse').map((c) => c.spec);
}

/** The first job constraint of a kind, typed by the caller (add-reuse-placer: the reference board, the plan, the registry). */
export function constraintOf<T>(job: PlacementJob, kind: string): T | null {
  const hit = job.constraints.find((c) => typeof c === 'object' && c !== null && (c as { kind?: string }).kind === kind);
  return hit ? ((hit as { kind: string } & { value: T }).value ?? null) : null;
}

/** Place a spec's members around the anchor as it stands in `design`. Members that are not movable (or absent) are skipped and named. */
export function applySpec(spec: LayoutBlockSpec, design: PcbDesign, movable: Set<string>): { placements: PlacedComponent[]; skipped: string[] } {
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const anchor = byRef.get(spec.anchor);
  const placements: PlacedComponent[] = [];
  const skipped: string[] = [];
  if (!anchor) return { placements, skipped: [`anchor ${spec.anchor} not on the board`] };
  for (const m of spec.members) {
    const c = byRef.get(m.ref);
    if (!c || !movable.has(c.id) || c.attributes.locked) {
      skipped.push(m.ref);
      continue;
    }
    const d = rotatePoint({ x: m.rel.x, y: m.rel.y }, anchor.rotation);
    // a side flip is refused by the exporter; keep the member on its own side and say so
    const side = c.attributes.side;
    if (side !== m.side) skipped.push(`${m.ref} (side ${m.side} in the reference, ${side} here; kept)`);
    placements.push({ id: c.id, at: { x: Math.round(anchor.at.x + d.x), y: Math.round(anchor.at.y + d.y) }, rotation: normMdeg(anchor.rotation + m.rel.rotation), side });
  }
  return { placements, skipped };
}

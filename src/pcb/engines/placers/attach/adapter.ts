/**
 * placer-attach: stage 3 of the staged placement plan (RFC 11 §8.5). Rule
 * placement of `relative.attached` parts next to the pins they attach to,
 * and layout reuse for blocks carrying a reference. Deterministic, places
 * only what a constraint already fixes; exempt from §3.8.
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { ComponentInstance, PlacedComponent } from '../../../ir/types.js';
import { bbox, bboxOf } from '../../../ir/geometry.js';
import type { BBox } from '../../../ir/geometry.js';
import { resultShape, specsOf, applySpec } from '../shared.js';

export const ATTACH_PLACER_MANIFEST: EngineManifest = {
  id: 'placer-attach',
  kind: 'placer',
  version: '1',
  adapterVersion: '1',
  license: 'Apache-2.0',
  inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  determinism: 'deterministic',
  executionMode: 'library',
  networkRequirement: 'none',
  harnessOnly: false,
  requires: {},
  capabilities: { bottomSide: false, rotation: false, arbitraryOutline: true, relativeConstraints: ['near'], fixedComponents: true, congestionAwareness: false, layoutReuse: true },
  supportedConstraints: ['relative.attached'],
};

/** `relative.attached`: part `ref` sits within `max_distance_nm` of `to` (a refdes, optionally `REF.PIN`). Travels in job.constraints as `{ kind: 'relative.attached', ref, to, max_distance_nm }`. */
export interface AttachedConstraint {
  kind: 'relative.attached';
  ref: string;
  to: string;
  max_distance_nm: number;
}

export function attachedOf(job: PlacementJob): AttachedConstraint[] {
  return job.constraints.filter((c): c is AttachedConstraint => typeof c === 'object' && c !== null && (c as { kind?: string }).kind === 'relative.attached');
}

/**
 * The region a part's subsystem was given, by refdes.
 *
 * This stage places and then locks most of the board, so a part it puts outside
 * its region is a part no later rule may move: measured on esp32-amp, the
 * region legalizer could only reach 6 parts of 30 because the other 22 were
 * already locked here. Regions therefore have to bind while the slots are being
 * chosen, not afterwards.
 */
export interface RegionConstraint {
  kind: 'functional.region';
  /** Refdes of the members. */
  refs: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function regionsOf(job: PlacementJob): Map<string, RegionConstraint['bounds']> {
  const out = new Map<string, RegionConstraint['bounds']>();
  for (const c of job.constraints) {
    if (typeof c !== 'object' || c === null || (c as { kind?: string }).kind !== 'functional.region') continue;
    const r = c as RegionConstraint;
    for (const ref of r.refs) out.set(ref, r.bounds);
  }
  return out;
}

export class AttachPlacer implements PlacerPlugin {
  async manifest(): Promise<EngineManifest> {
    return ATTACH_PLACER_MANIFEST;
  }
  async place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const design = job.snapshot.design;
    const movable = new Set(job.movableComponentIds);
    const byRef = new Map(design.components.map((c) => [c.reference, c]));
    const placements: PlacedComponent[] = [];
    const done = new Set<string>();
    // reuse blocks first: they fix whole groups
    for (const spec of specsOf(job)) {
      const { placements: ps, skipped } = applySpec(spec, design, movable);
      for (const s of skipped) ctx.log(`layout block ${spec.id}: skipped ${s}`);
      for (const p of ps) if (!done.has(p.id)) {
        done.add(p.id);
        placements.push(p);
      }
    }
    // Then single attachments. The part goes just outside the target's extent on
    // the side facing the pin, but two things constrain where it may actually
    // land, and neither used to be checked:
    //
    //  - Several parts commonly attach to one pin (two decoupling caps on a
    //    supply pad, a divider pair on a config pin). They share a target, a pin
    //    and therefore a direction, so a position computed from the target alone
    //    is the same position for all of them and they stack. `taken` records
    //    what this stage has already put down, and siblings fan around the
    //    target instead.
    //  - The pin's own direction can point off the board, which is routine once
    //    stage 1 has pulled a connector to an edge: everything attached to it
    //    then wants to sit outside the outline.
    //
    // Tightest constraint first, so a `critical` attachment gets the spot next
    // to its pin and a loose one takes what is left.
    const clearance = design.board.rules.copperEdgeClearanceNm;
    const inner = bbox(design.board.outline);
    // What a part occupies, for the purpose of not landing on top of it.
    //
    // Deliberately the pads and the fabrication body rather than the courtyard.
    // A courtyard is a clearance zone, and `importBoard` collapses disjoint
    // pieces into their common bounding box, so ESP32-S3-WROOM-1's 19.5 x 20.2
    // mm body fuses with its 48 x 21 mm antenna keep-out into one 48 x 41.2 mm
    // rectangle. Treating that as occupied space blocks most of a 40 mm board
    // and this stage then places nothing near the module at all. The real
    // courtyard rule is still enforced downstream by the geometry checker and
    // KiCad DRC; this is only a seeding heuristic.
    const extentOf = (c: ComponentInstance) => {
      const pads = c.pads.length ? bboxOf(c.pads.map((p) => p.copper)) : null;
      const body = c.footprint.body ? bbox(c.footprint.body) : null;
      if (pads && body) return { minX: Math.min(pads.minX, body.minX), maxX: Math.max(pads.maxX, body.maxX), minY: Math.min(pads.minY, body.minY), maxY: Math.max(pads.maxY, body.maxY) };
      return pads ?? body ?? bbox(c.footprint.courtyard!);
    };
    // Static parts this stage must not land on: anything it cannot move, plus
    // whatever it has already placed.
    const taken: BBox[] = design.components
      .filter((c) => !movable.has(c.id) || c.attributes.locked)
      .map(extentOf);
    for (const p of placements) {
      const c = design.components.find((x) => x.id === p.id);
      if (!c) continue;
      const e = extentOf(c);
      taken.push({ minX: e.minX + (p.at.x - c.at.x), maxX: e.maxX + (p.at.x - c.at.x), minY: e.minY + (p.at.y - c.at.y), maxY: e.maxY + (p.at.y - c.at.y) });
    }
    const hits = (b: BBox) => taken.some((t) => b.minX < t.maxX && t.minX < b.maxX && b.minY < t.maxY && t.minY < b.maxY);
    const onBoard = (b: BBox) =>
      b.minX >= inner.minX + clearance && b.maxX <= inner.maxX - clearance &&
      b.minY >= inner.minY + clearance && b.maxY <= inner.maxY - clearance;

    const regionOf = regionsOf(job);
    const unplaced: string[] = [];
    for (const a of [...attachedOf(job)].sort((p, q) => p.max_distance_nm - q.max_distance_nm || p.ref.localeCompare(q.ref))) {
      const part = byRef.get(a.ref);
      const [targetRef, pin] = a.to.split('.');
      const target = byRef.get(targetRef ?? '');
      if (!part || !target || !movable.has(part.id) || part.attributes.locked || done.has(part.id)) continue;
      const pad = pin ? target.pads.find((p) => p.number === pin) : undefined;
      const at = pad ? pad.at : target.at;
      const tb = bboxOf(target.pads.map((p) => p.copper));
      const pe = extentOf(part);
      const halfW = (pe.maxX - pe.minX) / 2, halfH = (pe.maxY - pe.minY) / 2;
      const gap = Math.min(a.max_distance_nm / 2, 1_000_000);
      const region = regionOf.get(a.ref);
      // the outward direction from the target's centre through the pin, as a unit step
      const dx = at.x - target.at.x, dy = at.y - target.at.y;
      const primary: [number, number] = Math.abs(dx) >= Math.abs(dy) ? [dx >= 0 ? 1 : -1, 0] : [0, dy >= 0 ? 1 : -1];
      // that side first, then the two perpendiculars, then the far side
      const dirs: [number, number][] = [primary, [-primary[1], primary[0]], [primary[1], -primary[0]], [-primary[0], -primary[1]]];
      // and along each side, step away from the pin in both directions
      const step = Math.max(halfW, halfH) * 2 + clearance;
      const slots: number[] = [0];
      for (let k = 1; k <= 4; k++) slots.push(k * step, -k * step);

      // The nearest free slot wins, rather than the first one tried. This stage
      // seeds a placement; it does not own the `max_distance_nm` requirement,
      // which the intent checker tests on the finished board. Refusing to place
      // a part that misses it would only hand it to a generic placer that knows
      // nothing about the pin, so the distance orders the candidates instead of
      // filtering them, and a miss is logged.
      let best: { x: number; y: number; d: number } | null = null;
      for (const [ux, uy] of dirs) {
        for (const s of slots) {
          // fixed on the axis pointing away from the pin, stepped along the other
          const x = ux !== 0 ? (ux > 0 ? tb.maxX + gap + halfW : tb.minX - gap - halfW) : at.x + s;
          const y = uy !== 0 ? (uy > 0 ? tb.maxY + gap + halfH : tb.minY - gap - halfH) : at.y + s;
          const box: BBox = { minX: x - halfW, maxX: x + halfW, minY: y - halfH, maxY: y + halfH };
          if (!onBoard(box) || hits(box)) continue;
          if (region && !(box.minX >= region.minX && box.maxX <= region.maxX && box.minY >= region.minY && box.maxY <= region.maxY)) continue;
          const d = Math.hypot(x - at.x, y - at.y);
          if (!best || d < best.d) best = { x, y, d };
        }
      }
      if (!best && region) {
        // Its own region has no room. Leave it out rather than seed it
        // elsewhere and lock it there: a later rule can still place it, and a
        // part locked outside its region is one nothing can correct.
        ctx.log(`attach: ${a.ref} has no free spot inside its region beside ${a.to}; left to the placers`);
        unplaced.push(part.id);
        continue;
      }
      if (!best) {
        // Every slot is off the board or already occupied. Better to leave it to
        // the placers than to emit a position known to be bad.
        ctx.log(`attach: ${a.ref} has no free on-board spot beside ${a.to}; left to the placers`);
        unplaced.push(part.id);
        continue;
      }
      if (best.d > a.max_distance_nm) ctx.log(`attach: ${a.ref} seeded ${(best.d / 1e6).toFixed(1)} mm from ${a.to}, over its ${(a.max_distance_nm / 1e6).toFixed(1)} mm budget`);
      done.add(part.id);
      taken.push({ minX: best.x - halfW, maxX: best.x + halfW, minY: best.y - halfH, maxY: best.y + halfH });
      placements.push({ id: part.id, at: { x: Math.round(best.x), y: Math.round(best.y) }, rotation: part.rotation, side: part.attributes.side });
    }
    return resultShape(unplaced.length ? 'partial' : 'complete', placements, unplaced, (Date.now() - t0) / 1000, { engineId: ATTACH_PLACER_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() });
  }
}

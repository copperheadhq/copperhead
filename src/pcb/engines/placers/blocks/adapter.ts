/**
 * placer-blocks: our own placer, brick 1.
 *
 * It does one thing: every part goes inside the region its subsystem was given,
 * or it is reported unplaced. Nothing else. No wirelength, no attachments, no
 * orientation — those are later bricks, and each will be added only once this
 * one is measurably right.
 *
 * Why start here. Measured on esp32-amp across six floorplans, the existing
 * engines put 17% to 47% of parts inside their block, by 6 to 12 mm out on a
 * 40 mm board. A region was advisory everywhere: the packer packed against the
 * whole board, and the one rule that did enforce regions ran last, by which
 * point the staged plan had locked 22 of 30 parts and it could only reach 6.
 * Correcting placement afterwards cannot fix that. Deciding it inside the
 * region can.
 *
 * The method is deliberately the dullest thing that works: shelf packing,
 * largest part first, rows filled left to right and top to bottom inside the
 * region. It is deterministic, it has no parameters to tune, and its failure
 * mode is legible — a part that does not fit says so instead of landing
 * somewhere plausible and wrong.
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { ComponentInstance, PlacedComponent } from '../../../ir/types.js';
import type { BBox } from '../../../ir/geometry.js';
import { bbox, bboxOf } from '../../../ir/geometry.js';
import { moveComponent } from '../../../ir/transform.js';
import { normMdeg } from '../../../ir/units.js';
import { resultShape } from '../shared.js';

export const BLOCKS_PLACER_MANIFEST: EngineManifest = {
  id: 'placer-blocks',
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
  capabilities: {
    bottomSide: false,
    rotation: true,
    arbitraryOutline: true,
    relativeConstraints: ['near'],
    fixedComponents: true,
    congestionAwareness: false,
    layoutReuse: false,
  },
  supportedConstraints: ['functional.region', 'relative.attached', 'mechanical.edge', 'manufacturing.keepout'],
};

/** A subsystem and the rectangle it was given, in board nanometres. */
export interface RegionConstraint {
  kind: 'functional.region';
  id: string;
  /** Refdes of the members. */
  refs: string[];
  bounds: BBox;
}

/**
 * `relative.attached`: `ref` belongs within `max_distance_nm` of `to`, which is
 * a refdes or `REF.PIN`.
 *
 * Of the 18 attachments esp32-amp states, 17 target their own block's anchor
 * and all 18 name a pin. They are not a cross-cutting constraint but an
 * intra-block, anchor-to-satellite one, which is why they are honoured here in
 * the region loop rather than by a pass of their own.
 */
export interface AttachedConstraint {
  kind: 'relative.attached';
  ref: string;
  to: string;
  max_distance_nm: number;
}

export function attachedOf(job: PlacementJob): AttachedConstraint[] {
  return job.constraints.filter(
    (c): c is AttachedConstraint =>
      typeof c === 'object' && c !== null && (c as { kind?: string }).kind === 'relative.attached',
  );
}

/**
 * `mechanical.edge`: `ref` sits against that board edge.
 *
 * Covers a connector's `placement.fixed[].edge` and a radio's
 * `placement.rf[].edge` alike — both say the same thing about position, and the
 * radio's keep-out is a separate matter handled as its own obstacle.
 */
export interface EdgeConstraint {
  kind: 'mechanical.edge';
  ref: string;
  edge: 'north' | 'south' | 'east' | 'west';
}

export function edgesOf(job: PlacementJob): EdgeConstraint[] {
  return job.constraints.filter(
    (c): c is EdgeConstraint =>
      typeof c === 'object' && c !== null && (c as { kind?: string }).kind === 'mechanical.edge',
  );
}

/**
 * `manufacturing.keepout`: an area no part may occupy, stated as an offset from
 * its owner's origin so it follows that part when placed.
 *
 * ESP32-S3-WROOM-1 declares a 48 × 21 mm antenna clearance this way. The IR
 * drops it — `importBoard` carries board-level `zone` blocks only, so a
 * keep-out declared inside a `footprint` never reaches `design.board.keepouts`,
 * which is empty on this board. Without it the placer put as many as 18 of 30
 * parts inside the zone: a board that is perfectly fabricable and whose radio
 * does not work.
 */
export interface KeepoutConstraint {
  kind: 'manufacturing.keepout';
  /** Refdes of the part the zone belongs to. */
  owner: string;
  /** Offsets from that part's origin, and the zone's size. */
  dx: number;
  dy: number;
  w: number;
  h: number;
}

export function keepoutsOf(job: PlacementJob): KeepoutConstraint[] {
  return job.constraints.filter(
    (c): c is KeepoutConstraint =>
      typeof c === 'object' && c !== null && (c as { kind?: string }).kind === 'manufacturing.keepout',
  );
}

export function regionsOf(job: PlacementJob): RegionConstraint[] {
  return job.constraints.filter(
    (c): c is RegionConstraint =>
      typeof c === 'object' && c !== null && (c as { kind?: string }).kind === 'functional.region',
  );
}

/**
 * What a part occupies: its pads and its fabrication body, never its courtyard.
 *
 * A courtyard is a clearance zone, and the importer collapses disjoint pieces
 * into one bounding box — for ESP32-S3-WROOM-1 that fuses a 19.5 x 20.2 mm
 * module with its 48 x 21 mm antenna keep-out into a 48 x 41.2 mm rectangle
 * that fits inside no region on a 40 mm board. Clearance between parts is
 * applied separately, as a gap.
 */
export function occupancy(c: ComponentInstance): BBox {
  const pads = c.pads.length ? bboxOf(c.pads.map((p) => p.copper)) : null;
  const body = c.footprint.body ? bbox(c.footprint.body) : null;
  if (pads && body) {
    return {
      minX: Math.min(pads.minX, body.minX), maxX: Math.max(pads.maxX, body.maxX),
      minY: Math.min(pads.minY, body.minY), maxY: Math.max(pads.maxY, body.maxY),
    };
  }
  return pads ?? body ?? bbox(c.footprint.courtyard!);
}

const overlaps = (a: BBox, b: BBox) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
const grow = (b: BBox, d: number): BBox => ({ minX: b.minX - d, maxX: b.maxX + d, minY: b.minY - d, maxY: b.maxY + d });

export class BlocksPlacer implements PlacerPlugin {
  async manifest(): Promise<EngineManifest> {
    return BLOCKS_PLACER_MANIFEST;
  }

  async place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const design = job.snapshot.design;
    const movable = new Set(job.movableComponentIds);
    const byRef = new Map(design.components.map((c) => [c.reference, c]));
    const gap = design.board.rules.clearanceNm;

    const placements: PlacedComponent[] = [];
    const unplaced: string[] = [];
    const placed = new Set<string>();

    // Anything this placer may not move is an obstacle wherever it already is.
    const taken: BBox[] = design.components
      .filter((c) => !movable.has(c.id) || c.attributes.locked)
      .map((c) => occupancy(c));

    const ob = bbox(design.board.outline);
    const edgeInset = design.board.rules.copperEdgeClearanceNm;
    const edgeStep = Math.max(gap, 250_000);
    const edgeOf = new Map<string, EdgeConstraint['edge']>();
    for (const e of edgesOf(job)) edgeOf.set(e.ref, e.edge);

    // Attachments, indexed by the part that must move.
    const attach = new Map<string, AttachedConstraint>();
    for (const at of attachedOf(job)) if (!attach.has(at.ref)) attach.set(at.ref, at);

    /** The first free spot for `e` inside `region`, searched outward from `from`. */
    const nearestFree = (e: BBox, from: { x: number; y: number }, region: BBox): { x: number; y: number } | null => {
      const w = e.maxX - e.minX, h = e.maxY - e.minY;
      if (w > region.maxX - region.minX || h > region.maxY - region.minY) return null;
      // rings of candidate offsets at a fixed step, nearest ring first, so the
      // spot found is the closest one the region and its neighbours allow
      const step = Math.max(gap, 250_000);
      const rings = Math.ceil(Math.max(region.maxX - region.minX, region.maxY - region.minY) / step);
      for (let ring = 0; ring <= rings; ring++) {
        const cands: { x: number; y: number }[] = [];
        for (let i = -ring; i <= ring; i++) {
          const edge = ring === 0 ? [0] : [-ring, ring];
          for (const j of edge) {
            cands.push({ x: from.x + i * step, y: from.y + j * step });
            if (ring !== 0) cands.push({ x: from.x + j * step, y: from.y + i * step });
          }
        }
        // nearest-first within the ring keeps the result stable and tight
        cands.sort((p1, q1) => Math.hypot(p1.x - from.x, p1.y - from.y) - Math.hypot(q1.x - from.x, q1.y - from.y));
        for (const c of cands) {
          const box: BBox = { minX: c.x - w / 2, maxX: c.x + w / 2, minY: c.y - h / 2, maxY: c.y + h / 2 };
          if (box.minX < region.minX || box.maxX > region.maxX || box.minY < region.minY || box.maxY > region.maxY) continue;
          if (taken.some((t) => overlaps(grow(t, gap), box))) continue;
          return { x: box.minX, y: box.minY };
        }
      }
      return null;
    };

    /**
     * How far a part has been moved by this run, by id.
     *
     * A pad's coordinate in `design` is where the bootstrap grid left it. Once
     * the anchor is placed its pads are somewhere else, and a satellite aimed
     * at the stale coordinate searches around a point that is usually outside
     * the region altogether — which silently drops it through to the shelf
     * packer, placed nowhere near the pin it names.
     */
    const moved = new Map<string, { dx: number; dy: number }>();

    const put = (c: ComponentInstance, e: BBox, at: { x: number; y: number }, rotation?: number) => {
      moved.set(c.id, { dx: at.x - e.minX, dy: at.y - e.minY });
      placements.push({
        id: c.id,
        at: { x: Math.round(c.at.x + (at.x - e.minX)), y: Math.round(c.at.y + (at.y - e.minY)) },
        rotation: rotation ?? c.rotation,
        side: c.attributes.side,
      });
      placed.add(c.id);
      taken.push({ minX: at.x, maxX: at.x + (e.maxX - e.minX), minY: at.y, maxY: at.y + (e.maxY - e.minY) });
    };

    // Keep-outs are seeded as their owner is placed. A zone crosses whatever
    // regions it reaches, so it constrains every block, not the one that owns
    // it — but it cannot be seeded before the loop either, because where it
    // lands depends on where its owner goes. So: place every keep-out owner
    // first, across all regions, then seed the zones, then pack.
    const keepouts = keepoutsOf(job);
    if (keepouts.length) {
      for (const k of keepouts) {
        const owner = byRef.get(k.owner);
        if (!owner) continue;
        // its owner owes an edge, so place it now under the brick 3 rule
        const region = regionsOf(job).find((r) => r.refs.includes(k.owner));
        const want = edgeOf.get(k.owner);
        if (region && want && movable.has(owner.id) && !owner.attributes.locked && !placed.has(owner.id)) {
          const e = occupancy(owner);
          const w = e.maxX - e.minX, h = e.maxY - e.minY;
          const fixed = want === 'north' ? ob.minY + edgeInset
            : want === 'south' ? ob.maxY - edgeInset - h
            : want === 'west' ? ob.minX + edgeInset
            : ob.maxX - edgeInset - w;
          const vertical = want === 'north' || want === 'south';
          const lo = vertical ? region.bounds.minX : region.bounds.minY;
          const hi = (vertical ? region.bounds.maxX : region.bounds.maxY) - (vertical ? w : h);
          if (hi >= lo) {
            const mid = (lo + hi) / 2;
            const box: BBox = vertical
              ? { minX: mid, maxX: mid + w, minY: fixed, maxY: fixed + h }
              : { minX: fixed, maxX: fixed + w, minY: mid, maxY: mid + h };
            put(owner, e, { x: box.minX, y: box.minY });
          }
        }
        const d0 = moved.get(owner.id) ?? { dx: 0, dy: 0 };
        const zone: BBox = {
          minX: owner.at.x + k.dx + d0.dx, maxX: owner.at.x + k.dx + k.w + d0.dx,
          minY: owner.at.y + k.dy + d0.dy, maxY: owner.at.y + k.dy + k.h + d0.dy,
        };
        taken.push(zone);
        ctx.log(`blocks: ${k.owner} keep-out ${(k.w / 1e6).toFixed(0)} x ${(k.h / 1e6).toFixed(0)} mm reserved`);
      }
    }

    for (const region of regionsOf(job)) {
      const members = region.refs
        .map((r) => byRef.get(r))
        .filter((c): c is ComponentInstance => !!c && movable.has(c.id) && !c.attributes.locked && !placed.has(c.id));
      const memberRefs = new Set(members.map((c) => c.reference));

      // ---- brick 3, step 0: parts that owe an edge -------------------------
      // First, because they have the least freedom: one coordinate is dictated
      // by the board outline and only the other is ours to choose. Placing them
      // after the anchor would leave them whatever the anchor did not want,
      // and a connector off its edge is a board nobody can plug into.
      for (const c of members) {
        if (placed.has(c.id)) continue;
        const want = edgeOf.get(c.reference);
        if (!want) continue;
        const e = occupancy(c);
        const w = e.maxX - e.minX, h = e.maxY - e.minY;
        // flush to the board edge, inset by the copper-to-edge clearance
        const fixed = want === 'north' ? ob.minY + edgeInset
          : want === 'south' ? ob.maxY - edgeInset - h
          : want === 'west' ? ob.minX + edgeInset
          : ob.maxX - edgeInset - w;
        const vertical = want === 'north' || want === 'south';
        const lo = vertical ? region.bounds.minX : region.bounds.minY;
        const hi = (vertical ? region.bounds.maxX : region.bounds.maxY) - (vertical ? w : h);
        if (hi < lo) {
          ctx.log(`blocks: ${c.reference} does not fit along the ${want} edge of region ${region.id}`);
          unplaced.push(c.id);
          continue;
        }
        // scan outward from the middle of the region's span, so a connector
        // sits centrally on its edge unless something is already there
        const mid = (lo + hi) / 2;
        let spot: { x: number; y: number } | null = null;
        for (let k = 0; k <= Math.ceil((hi - lo) / edgeStep) && !spot; k++) {
          for (const at of k === 0 ? [mid] : [mid + k * edgeStep, mid - k * edgeStep]) {
            if (at < lo || at > hi) continue;
            const box: BBox = vertical
              ? { minX: at, maxX: at + w, minY: fixed, maxY: fixed + h }
              : { minX: fixed, maxX: fixed + w, minY: at, maxY: at + h };
            if (taken.some((t) => overlaps(grow(t, gap), box))) continue;
            spot = { x: box.minX, y: box.minY };
            break;
          }
        }
        if (!spot) {
          ctx.log(`blocks: no free spot for ${c.reference} along the ${want} edge of region ${region.id}`);
          unplaced.push(c.id);
          continue;
        }
        put(c, e, spot);
      }

      // ---- brick 2, step 1: the anchor ------------------------------------
      // Whatever this block's attachments point at. Almost always its own
      // anchor IC; a block with none just shelf-packs as brick 1 did.
      const targets = members
        .map((c) => attach.get(c.reference))
        .filter((a): a is AttachedConstraint => !!a)
        .map((a) => a.to.split('.')[0]!)
        .filter((t) => memberRefs.has(t));
      const anchorRef = targets.length
        ? [...new Set(targets)].sort((x, y) => targets.filter((t) => t === y).length - targets.filter((t) => t === x).length || x.localeCompare(y))[0]!
        : null;
      const anchor = anchorRef ? byRef.get(anchorRef) : undefined;

      if (anchor && !placed.has(anchor.id)) {
        const e = occupancy(anchor);
        const w = e.maxX - e.minX, h = e.maxY - e.minY;
        // Centred in its region: its satellites have to surround it, and a
        // corner leaves them only two sides to use. Biasing the anchor toward
        // the pins that carry attachments is the obvious refinement and is
        // deliberately not done yet — it is worth measuring against this.
        const cx = (region.bounds.minX + region.bounds.maxX) / 2;
        const cy = (region.bounds.minY + region.bounds.maxY) / 2;
        const spot = nearestFree(e, { x: cx, y: cy }, region.bounds);
        if (spot) put(anchor, e, spot);
        else {
          ctx.log(`blocks: region ${region.id} has no room for its anchor ${anchor.reference}`);
          unplaced.push(anchor.id);
        }
        if (w > region.bounds.maxX - region.bounds.minX || h > region.bounds.maxY - region.bounds.minY) {
          ctx.log(`blocks: anchor ${anchor.reference} is larger than region ${region.id}`);
        }
      }

      // ---- brick 2, step 2: satellites, beside the pin they name ----------
      // Nearest free spot to the *pad*, not to the target's bounding box. The
      // old attach stage measured from the whole pad bbox, so every pin on a
      // 19 mm module gave the same position ~10 mm out and a 2 mm decoupling
      // budget could not be met however the search was tuned.
      const satellites = members
        .filter((c) => !placed.has(c.id) && attach.has(c.reference))
        .map((c) => ({ c, a: attach.get(c.reference)! }))
        .sort((x, y) => x.a.max_distance_nm - y.a.max_distance_nm || x.c.reference.localeCompare(y.c.reference));

      for (const { c, a } of satellites) {
        const [targetRef, pin] = a.to.split('.');
        const target = byRef.get(targetRef ?? '');
        if (!target) continue;
        const pad = pin ? target.pads.find((q) => q.number === pin) : undefined;
        const raw = pad ? pad.at : target.at;
        const d0 = moved.get(target.id) ?? { dx: 0, dy: 0 };
        const from = { x: raw.x + d0.dx, y: raw.y + d0.dy };

        // Brick 4: try each quarter turn and keep the one that brings the
        // part's *connecting pad* nearest the pin, not its centre. A 0402 one
        // millimetre from its pad but turned across it needs a longer, worse
        // trace than the same part turned along it, and until now nothing here
        // ever rotated anything: every part on the board sat at 0 degrees.
        const netId = pad?.netId ?? null;
        let best: { e: BBox; spot: { x: number; y: number }; rot: number; d: number } | null = null;
        for (const turn of [0, 90_000, 180_000, 270_000]) {
          const rot = normMdeg(c.rotation + turn);
          const cand = turn === 0 ? c : moveComponent(c, { id: c.id, at: c.at, rotation: rot, side: c.attributes.side });
          const e = occupancy(cand);
          const spot = nearestFree(e, from, region.bounds);
          if (!spot) continue;
          // where the connecting pad lands once the part is moved there
          const dx = spot.x - e.minX, dy = spot.y - e.minY;
          const mine = netId ? cand.pads.find((q) => q.netId === netId) : undefined;
          const at = mine ? { x: mine.at.x + dx, y: mine.at.y + dy } : { x: spot.x + (e.maxX - e.minX) / 2, y: spot.y + (e.maxY - e.minY) / 2 };
          const d = Math.hypot(at.x - from.x, at.y - from.y);
          if (!best || d < best.d) best = { e, spot, rot, d };
        }
        if (!best) {
          ctx.log(`blocks: ${c.reference} has no free spot near ${a.to} inside region ${region.id}; shelf-packed instead`);
          continue;
        }
        if (best.d > a.max_distance_nm) {
          ctx.log(`blocks: ${c.reference} is ${(best.d / 1e6).toFixed(1)} mm from ${a.to}, over its ${(a.max_distance_nm / 1e6).toFixed(1)} mm budget`);
        }
        put(c, best.e, best.spot, best.rot);
      }

      // ---- brick 5, step 3: the rest, nearest their own connections -------
      // Brick 1 shelf-packed these by size, which is the right answer for
      // fitting and the wrong one for routing: a part landed wherever its area
      // put it in the queue, however far that was from everything it joins to.
      // Place the best-connected part first and put each at the nearest free
      // spot to the centre of the pads it shares a net with, falling back to
      // the shelf packer when nothing it connects to has been placed yet.
      const netOf = new Map<string, Set<string>>();          // component id -> net ids
      for (const c of design.components) {
        const set = new Set<string>();
        for (const q of c.pads) if (q.netId) set.add(q.netId);
        netOf.set(c.id, set);
      }
      const rails = new Set<string>();                        // ground and power carry no placement signal
      for (const n of design.nets) if (n.padIds.length > 8) rails.add(n.id);
      const neighbours = (c: ComponentInstance) => {
        const mine = netOf.get(c.id) ?? new Set();
        return design.components.filter((o) => o.id !== c.id && [...(netOf.get(o.id) ?? [])].some((x) => mine.has(x) && !rails.has(x)));
      };

      const remaining = members.filter((c) => !placed.has(c.id));
      const order: { c: ComponentInstance; e: BBox }[] = [];
      const queue = [...remaining];
      while (queue.length) {
        // most connections to something already placed, then largest, then name
        queue.sort((p1, q1) => {
          const np = neighbours(p1).filter((o) => placed.has(o.id)).length;
          const nq = neighbours(q1).filter((o) => placed.has(o.id)).length;
          const ep = occupancy(p1), eq = occupancy(q1);
          return nq - np
            || (eq.maxX - eq.minX) * (eq.maxY - eq.minY) - (ep.maxX - ep.minX) * (ep.maxY - ep.minY)
            || p1.reference.localeCompare(q1.reference);
        });
        const c = queue.shift()!;
        const anchors2 = neighbours(c).filter((o) => placed.has(o.id));
        if (anchors2.length) {
          const pts = anchors2.map((o) => {
            const d = moved.get(o.id) ?? { dx: 0, dy: 0 };
            return { x: o.at.x + d.dx, y: o.at.y + d.dy };
          });
          const from = { x: pts.reduce((a, q) => a + q.x, 0) / pts.length, y: pts.reduce((a, q) => a + q.y, 0) / pts.length };
          const e = occupancy(c);
          const spot = nearestFree(e, from, region.bounds);
          if (spot) {
            put(c, e, spot);
            continue;
          }
        }
        order.push({ c, e: occupancy(c) });                   // shelf packer takes it
      }

      let shelfY = region.bounds.minY;   // top of the row being filled
      let cursorX = region.bounds.minX;  // next free x in that row
      let shelfH = 0;                    // tallest part in the row so far

      for (const { c, e } of order) {
        const w = e.maxX - e.minX, h = e.maxY - e.minY;
        if (w > region.bounds.maxX - region.bounds.minX || h > region.bounds.maxY - region.bounds.minY) {
          ctx.log(`blocks: ${c.reference} (${(w / 1e6).toFixed(1)} x ${(h / 1e6).toFixed(1)} mm) is larger than region ${region.id}`);
          unplaced.push(c.id);
          continue;
        }
        // Walk shelves until the part fits in one, against its neighbours in the
        // row and against anything already standing there.
        //
        // When blocked, step to just past the blocker's right edge rather than
        // by a fixed amount. Regions share boundaries, and a part packed flush
        // against one carries its clearance halo across it, so a neighbouring
        // region's left edge is routinely obstructed by a fraction of a
        // millimetre. Stepping by a fixed amount wrapped to a new shelf barely
        // lower and retried the same blocked column until the guard gave up:
        // J2 was reported unplaceable in a region with room for it twice over.
        let spot: { x: number; y: number } | null = null;
        for (let guard = 0; guard < 4 * order.length + 16 && !spot; guard++) {
          if (cursorX + w > region.bounds.maxX) {           // row full: open the next
            // an empty row advances by the part's own height, not by nothing
            shelfY += (shelfH || h) + gap;
            cursorX = region.bounds.minX;
            shelfH = 0;
          }
          if (shelfY + h > region.bounds.maxY) break;        // region full
          const box: BBox = { minX: cursorX, maxX: cursorX + w, minY: shelfY, maxY: shelfY + h };
          const blocker = taken.find((t) => overlaps(grow(t, gap), box));
          if (blocker) {
            cursorX = Math.max(cursorX + 1, blocker.maxX + gap);
            continue;
          }
          spot = { x: cursorX, y: shelfY };
        }
        if (!spot) {
          ctx.log(`blocks: region ${region.id} has no room left for ${c.reference}`);
          unplaced.push(c.id);
          continue;
        }
        put(c, e, spot);
        cursorX = spot.x + w + gap;
        shelfH = Math.max(shelfH, h);
      }
    }

    // A part in no region is not this brick's business; it keeps its position.
    return resultShape(
      unplaced.length ? 'partial' : 'complete',
      placements,
      unplaced,
      (Date.now() - t0) / 1000,
      { engineId: BLOCKS_PLACER_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() },
    );
  }
}

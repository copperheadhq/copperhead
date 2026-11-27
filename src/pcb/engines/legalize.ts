/**
 * Rule stages the B3 evidence asked for (RFC 11 §8.5 stages 1 and 2; task 7.0).
 * Deterministic, place-or-move-only-what-a-constraint-fixes steps, exempt from
 * §3.8 because they search nothing:
 *   - edge: a part with `mechanical.edge` goes against that edge; `mechanical.fixed` goes to its point
 *   - keepout: a part inside a keepout (rule area or mounting-hole ring) moves the least distance out
 *   - separation: two blocks closer than their minimum are pushed apart along the line of their centroids
 *   - edge: a part a wrapped placer left inside the copper-to-edge clearance is moved the least distance back in
 * Every move is returned as a placement plus a note, so the run records what was legalized.
 */
import type { PcbDesign, ComponentInstance, PlacedComponent } from '../ir/types.js';
import type { Polygon } from '../ir/geometry.js';
import { bbox, bboxOf, circle, intersects, distance as polyDistance, translate, placeLocal } from '../ir/geometry.js';
import { normMdeg } from '../ir/units.js';
import type { Constraint } from '../../memory/constraints.js';
import { EDGE_ORDER, type BoardEdge } from '../intent/blocks.js';
import { moveComponent } from '../ir/transform.js';

export interface LegalizeResult {
  placements: PlacedComponent[];
  notes: string[];
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function extent(c: ComponentInstance): Polygon | null {
  if (c.footprint.courtyard) return c.footprint.courtyard;
  if (!c.pads.length) return null;
  const b = bboxOf(c.pads.map((p) => p.copper));
  return { outer: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], holes: [] };
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));

/**
 * Which way a connector mates, in its own current frame, or null when it has no
 * in-plane facing at all.
 *
 * `orientation: outward` used to be parsed and then dropped, on the grounds
 * that facing is footprint-specific. It is recoverable from the footprint
 * itself: an edge connector's body overhangs its pads on the side the cable or
 * plug arrives from, because that is where the shell or the wire entry sits.
 * A USB-C receptacle overhangs 2.31 mm on one side against 0.5 mm elsewhere; a
 * horizontal terminal block 2.50 mm against 0.51 mm.
 *
 * A part with no such asymmetry has nothing to turn: a vertical pin header
 * overhangs 0.92 mm on all four sides because it is mated from above, not from
 * an edge. Those keep whatever rotation they have, and say so.
 */
export function matingFace(comp: ComponentInstance): BoardEdge | null {
  if (!comp.footprint.courtyard || !comp.pads.length) return null;
  const cy = bbox(comp.footprint.courtyard);
  const pb = bboxOf(comp.pads.map((p) => p.copper));
  const over: Record<BoardEdge, number> = {
    north: pb.minY - cy.minY, south: cy.maxY - pb.maxY,
    west: pb.minX - cy.minX, east: cy.maxX - pb.maxX,
  };
  const order = (Object.entries(over) as [BoardEdge, number][]).sort((a, b) => b[1] - a[1]);
  const [face, most] = order[0]!;
  const next = order[1]![1];
  // A real facing stands well clear of the others; 0.5 mm of silkscreen margin
  // on every side is not a direction.
  return most > 500_000 && most > next * 1.5 ? face : null;
}

const EDGE_ANGLE: Record<BoardEdge, number> = { north: 0, east: 90, south: 180, west: 270 };

/** The rotation that turns `from` to point at `to`, in millidegrees. */
export function turnToFace(from: BoardEdge, to: BoardEdge): number {
  return normMdeg(((EDGE_ANGLE[to] - EDGE_ANGLE[from] + 360) % 360) * 1000);
}

/** Stage 1: parts a mechanical constraint fixes outright. */
export function placeMechanical(design: PcbDesign, registry: Record<string, Constraint>, movable: Set<string>): LegalizeResult {
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  const out: PlacedComponent[] = [];
  const notes: string[] = [];
  for (const [key, c] of Object.entries(registry)) {
    // `layout.rf.edge.<ref>` is class `emc`, not `mechanical`, but it says the
    // same thing a connector's edge says: this part belongs against that edge.
    // It used to be checked and never acted on, so a radio only reached its
    // edge if something else happened to put it there.
    const isRfEdge = c.class === 'emc' && key.startsWith('layout.rf.edge.');
    if (c.class !== 'mechanical' && !isRfEdge) continue;
    const comp = byRef.get(c.scope?.refs?.[0] ?? '');
    if (!comp || !movable.has(comp.id) || comp.attributes.locked) continue;
    const p = c.parameters ?? {};
    if (isRfEdge) {
      const edge = String(p.edge ?? '');
      if (!(EDGE_ORDER as readonly string[]).includes(edge)) continue;
      // Measured on pads and body, not the courtyard: a module's courtyard
      // includes the antenna clearance, so aligning that to the edge would put
      // the module a clearance-depth inside the board instead of at it.
      const pads = comp.pads.length ? bboxOf(comp.pads.map((q) => q.copper)) : null;
      const body = comp.footprint.body ? bbox(comp.footprint.body) : null;
      const e = pads && body
        ? { minX: Math.min(pads.minX, body.minX), maxX: Math.max(pads.maxX, body.maxX), minY: Math.min(pads.minY, body.minY), maxY: Math.max(pads.maxY, body.maxY) }
        : pads ?? body;
      if (!e) continue;
      const dx = edge === 'west' ? ob.minX + inset - e.minX : edge === 'east' ? ob.maxX - inset - e.maxX : 0;
      const dy = edge === 'north' ? ob.minY + inset - e.minY : edge === 'south' ? ob.maxY - inset - e.maxY : 0;
      if (Math.abs(dx) > 10_000 || Math.abs(dy) > 10_000) {
        out.push({ id: comp.id, at: { x: comp.at.x + dx, y: comp.at.y + dy }, rotation: comp.rotation, side: comp.attributes.side });
        notes.push(`${comp.reference} moved ${(Math.hypot(dx, dy) / 1e6).toFixed(1)} mm to the ${edge} edge for its antenna`);
      }
      continue;
    }
    if (key.startsWith('layout.mechanical.fixed.')) {
      const x = num(p.x_nm, comp.at.x), y = num(p.y_nm, comp.at.y);
      if (x !== comp.at.x || y !== comp.at.y) {
        out.push({ id: comp.id, at: { x, y }, rotation: p.rotation_mdeg !== undefined ? num(p.rotation_mdeg) : comp.rotation, side: comp.attributes.side });
        notes.push(`${comp.reference} moved to its fixed position`);
      }
    } else if (key.startsWith('layout.mechanical.edge.')) {
      const e = extent(comp);
      if (!e) continue;
      const edge = String(p.edge);

      // `orientation: outward` turns the part so the side a plug or wire
      // arrives from faces off the board. Rotating changes the extent, so this
      // happens before the extent is measured for the move below.
      let rotation = comp.rotation;
      let turned: ComponentInstance = comp;
      let turnNote: string | null = null;
      if (String(p.orientation) === 'outward' && (EDGE_ORDER as readonly string[]).includes(edge)) {
        const face = matingFace(comp);
        if (!face) turnNote = `${comp.reference}: no in-plane facing in its footprint; orientation "outward" left it as it is`;
        else {
          const turn = turnToFace(face, edge as BoardEdge);
          if (turn !== 0) {
            rotation = normMdeg(comp.rotation + turn);
            turned = moveComponent(comp, { id: comp.id, at: comp.at, rotation, side: comp.attributes.side });
            turnNote = `${comp.reference} turned ${(turn / 1000).toFixed(0)}\u00b0 to face ${edge}`;
          }
        }
      }
      const eb = bbox(extent(turned) ?? e);
      let dx = 0, dy = 0;
      if (edge === 'west') dx = ob.minX + inset - eb.minX;
      else if (edge === 'east') dx = ob.maxX - inset - eb.maxX;
      else if (edge === 'north') dy = ob.minY + inset - eb.minY;
      else if (edge === 'south') dy = ob.maxY - inset - eb.maxY;
      // Where along the edge. A derived constraint carries its block's region
      // centre (`along_nm`), so the connector lands in its own subsystem's span
      // rather than keeping whatever the bootstrap grid gave it — which is an
      // arbitrary coordinate, and the part is locked straight afterwards, so a
      // collision there is one no later stage can undo. Clamped to keep the
      // extent inside the outline. A user-authored edge carries no `along_nm`
      // and keeps its other coordinate, as before.
      //
      // The clamp applies whether or not `along_nm` was given. A user-authored
      // edge used to keep its other coordinate untouched, which is only safe
      // while that coordinate is already inside the outline: re-outline a board
      // smaller and the part keeps a coordinate that is now past the edge, and
      // is then locked there with its pads off the board.
      const alongAxis = edge === 'west' || edge === 'east' ? 'y' : 'x';
      const half = alongAxis === 'y' ? (eb.maxY - eb.minY) / 2 : (eb.maxX - eb.minX) / 2;
      const centre = alongAxis === 'y' ? (eb.minY + eb.maxY) / 2 : (eb.minX + eb.maxX) / 2;
      const lo = alongAxis === 'y' ? ob.minY + inset + half : ob.minX + inset + half;
      const hi = alongAxis === 'y' ? ob.maxY - inset - half : ob.maxX - inset - half;
      const along = typeof p.along_nm === 'number' ? p.along_nm : centre;
      const delta = (lo <= hi ? clamp(along, lo, hi) : (lo + hi) / 2) - centre;
      if (alongAxis === 'y') dy = delta; else dx = delta;
      if (Math.abs(dx) > 10_000 || Math.abs(dy) > 10_000 || rotation !== comp.rotation) {
        out.push({ id: comp.id, at: { x: comp.at.x + dx, y: comp.at.y + dy }, rotation, side: comp.attributes.side });
        if (Math.abs(dx) > 10_000 || Math.abs(dy) > 10_000) notes.push(`${comp.reference} moved ${(Math.hypot(dx, dy) / 1e6).toFixed(1)} mm to the ${edge} edge`);
      }
      // after the move note, so "moved to the edge" stays the headline
      if (turnNote) notes.push(turnNote);
    }
  }
  return { placements: out, notes };
}

/** The keepout zones a registry describes, as polygons. */
export function keepoutZones(design: PcbDesign, registry: Record<string, Constraint>): { key: string; zone: Polygon }[] {
  const zones: { key: string; zone: Polygon }[] = [];
  for (const [key, c] of Object.entries(registry)) {
    if (c.class !== 'manufacturing' || !key.startsWith('layout.manufacturing.keepout.')) continue;
    const p = c.parameters ?? {};
    const prohibit = strs(p.prohibit);
    if (prohibit.length && !prohibit.some((x) => ['components', 'footprints', 'pads'].includes(x))) continue;
    if (typeof p.polygon === 'string' && p.polygon) {
      try {
        zones.push({ key, zone: { outer: (JSON.parse(p.polygon) as [number, number][]).map(([x, y]) => ({ x, y })), holes: [] } });
      } catch {
        // unreadable polygon: nothing to legalize against
      }
    } else if (String(p.region) === 'mounting_hole_ring') {
      const r = num(p.radius_nm, 2_000_000);
      for (const comp of design.components) for (const pad of comp.pads) if (pad.type === 'np_thru_hole' || /^H\d/.test(comp.reference)) zones.push({ key, zone: circle(pad.at.x, pad.at.y, (pad.drill?.d ?? 0) + 2 * r) });
    }
  }
  return zones;
}

/** Least translation (axis-aligned, on bounding boxes) that takes `box` out of `zone`. */
function pushOut(box: Box, zone: Box, gap: number): { dx: number; dy: number } {
  const cands = [
    { dx: zone.minX - gap - box.maxX, dy: 0 },
    { dx: zone.maxX + gap - box.minX, dy: 0 },
    { dx: 0, dy: zone.minY - gap - box.maxY },
    { dx: 0, dy: zone.maxY + gap - box.minY },
  ];
  return cands.reduce((a, b) => (Math.hypot(b.dx, b.dy) < Math.hypot(a.dx, a.dy) ? b : a));
}

/** Stage 2 rule: move movable parts out of keepouts, then back inside the outline if the push overshot. */
export function legalizeKeepouts(design: PcbDesign, registry: Record<string, Constraint>, movable: Set<string>, placements: PlacedComponent[]): LegalizeResult {
  const zones = keepoutZones(design, registry);
  const notes: string[] = [];
  if (!zones.length) return { placements, notes };
  const byId = new Map(placements.map((p) => [p.id, p]));
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  for (const comp of design.components) {
    if (!movable.has(comp.id) || comp.attributes.locked) continue;
    if (comp.pads.every((pad) => pad.type === 'np_thru_hole') || /^H\d/.test(comp.reference)) continue;
    const e0 = extent(comp);
    if (!e0) continue;
    const placed = byId.get(comp.id);
    let e = placed ? placeLocal(translate(e0, -comp.at.x, -comp.at.y), placed.at, normMdeg(placed.rotation - comp.rotation)) : e0;
    let at = placed ? { ...placed.at } : { ...comp.at };
    for (let pass = 0; pass < 4; pass++) {
      const hit = zones.find((z) => intersects(e, z.zone));
      if (!hit) break;
      const zb = bbox(hit.zone);
      // KiCad judges 'footprints not allowed' on the footprint's full bounding box (reference text included): leave a millimetre
      const { dx, dy } = pushOut(bbox(e), zb, 1_000_000);
      at = { x: at.x + dx, y: at.y + dy };
      e = translate(e, dx, dy);
      notes.push(`${comp.reference} moved ${(Math.hypot(dx, dy) / 1e6).toFixed(1)} mm out of keepout ${hit.key.slice('layout.manufacturing.keepout.'.length)}`);
    }
    // keep it on the board
    const eb = bbox(e);
    const fx = eb.minX < ob.minX + inset ? ob.minX + inset - eb.minX : eb.maxX > ob.maxX - inset ? ob.maxX - inset - eb.maxX : 0;
    const fy = eb.minY < ob.minY + inset ? ob.minY + inset - eb.minY : eb.maxY > ob.maxY - inset ? ob.maxY - inset - eb.maxY : 0;
    if (fx || fy) at = { x: at.x + fx, y: at.y + fy };
    if (at.x !== (placed?.at.x ?? comp.at.x) || at.y !== (placed?.at.y ?? comp.at.y)) byId.set(comp.id, { id: comp.id, at, rotation: placed?.rotation ?? comp.rotation, side: placed?.side ?? comp.attributes.side });
  }
  return { placements: [...byId.values()], notes };
}

/** Stage 2 rule: two blocks under a separation constraint are pushed apart along the line of their centroids. */
export function legalizeSeparation(design: PcbDesign, registry: Record<string, Constraint>, movable: Set<string>, placements: PlacedComponent[]): LegalizeResult {
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const byId = new Map(placements.map((p) => [p.id, p]));
  const notes: string[] = [];
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  const placedExtent = (c: ComponentInstance): Polygon | null => {
    const e = extent(c);
    const p = byId.get(c.id);
    return e && p ? translate(e, p.at.x - c.at.x, p.at.y - c.at.y) : e;
  };
  for (const [key, c] of Object.entries(registry)) {
    if (c.class !== 'functional' || !key.startsWith('layout.functional.separation.')) continue;
    const [ga, gb] = strs(c.parameters?.groups);
    const members = (g: string | undefined) => strs(registry[`layout.functional.group.${g ?? ''}`]?.parameters?.members).map((r) => byRef.get(r)).filter((x): x is ComponentInstance => !!x);
    const a = members(ga), b = members(gb);
    const min = num(c.parameters?.min_nm, 0);
    if (!a.length || !b.length || !min) continue;
    let best = Number.POSITIVE_INFINITY;
    for (const x of a) for (const y of b) {
      const ex = placedExtent(x), ey = placedExtent(y);
      if (ex && ey) best = Math.min(best, polyDistance(ex, ey));
    }
    if (best >= min) continue;
    // move the block with fewer movable parts (ties: b) away by the shortfall plus a margin, along the centroid line
    const movA = a.filter((x) => movable.has(x.id) && !x.attributes.locked), movB = b.filter((x) => movable.has(x.id) && !x.attributes.locked);
    const mover = movB.length && movB.length <= (movA.length || Infinity) ? movB : movA;
    const stayer = mover === movB ? a : b;
    if (!mover.length) {
      notes.push(`${ga}/${gb}: ${(best / 1e6).toFixed(1)} mm apart against ${(min / 1e6).toFixed(1)} mm, and neither block is movable`);
      continue;
    }
    const cen = (cs: ComponentInstance[]) => ({ x: cs.reduce((s, x) => s + (byId.get(x.id)?.at.x ?? x.at.x), 0) / cs.length, y: cs.reduce((s, x) => s + (byId.get(x.id)?.at.y ?? x.at.y), 0) / cs.length });
    const cm = cen(mover), cs = cen(stayer);
    let ux = cm.x - cs.x, uy = cm.y - cs.y;
    const len = Math.hypot(ux, uy) || 1;
    ux /= len;
    uy /= len;
    if (!Math.hypot(ux, uy)) ux = 1;
    const shift = min - best + 500_000;
    // clamp the shift so the mover stays inside the outline
    const boxes = mover.map(placedExtent).filter((p): p is Polygon => !!p);
    const mb = bboxOf(boxes);
    const maxX = ux > 0 ? (ob.maxX - inset - mb.maxX) / ux : ux < 0 ? (ob.minX + inset - mb.minX) / ux : Infinity;
    const maxY = uy > 0 ? (ob.maxY - inset - mb.maxY) / uy : uy < 0 ? (ob.minY + inset - mb.minY) / uy : Infinity;
    const s = Math.max(0, Math.min(shift, maxX, maxY));
    if (s <= 0) {
      notes.push(`${ga}/${gb}: no room to separate the blocks inside the outline`);
      continue;
    }
    for (const x of mover) {
      const p = byId.get(x.id);
      const at = p ? p.at : x.at;
      byId.set(x.id, { id: x.id, at: { x: Math.round(at.x + ux * s), y: Math.round(at.y + uy * s) }, rotation: p?.rotation ?? x.rotation, side: p?.side ?? x.attributes.side });
    }
    notes.push(`block ${mover === movB ? gb : ga} moved ${(s / 1e6).toFixed(1)} mm away from ${mover === movB ? ga : gb} (${(best / 1e6).toFixed(1)} mm apart against ${(min / 1e6).toFixed(1)} mm)${s < shift ? ', limited by the outline' : ''}`);
  }
  return { placements: [...byId.values()], notes };
}

/**
 * Stage 2 rule: a movable part outside its subsystem's region is moved the
 * least distance back inside it.
 *
 * A region used to be advisory at every level: the intent language could not
 * state one, the packer packed against the whole board, and the checker logged
 * a warning nobody gated on. Measured on esp32-amp, between a third and a half
 * of all parts sat outside the block they were given, by 6 to 11 mm on a 40 mm
 * board, so the floorplan had almost no effect on the result.
 *
 * This is the cheap half of the fix and it is not the good half. Packing each
 * subsystem inside its own boundary — the packer already takes a
 * `boundaryOutline`, one call per island — would place parts in their region
 * rather than move them there afterwards. Pushing a part in can put it on top
 * of a neighbour; the placement gate judges that, exactly as it does for the
 * edge rule above.
 *
 * Only regions a constraint states are enforced. A region derived from block
 * flow (`blocksToConstraints`) is a guess at signal order and stays advisory;
 * one written in the intent file is a requirement.
 */
export function legalizeRegions(design: PcbDesign, registry: Record<string, Constraint>, movable: Set<string>, placements: PlacedComponent[]): LegalizeResult {
  const byId = new Map(placements.map((p) => [p.id, p]));
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const notes: string[] = [];
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm;
  for (const [key, c] of Object.entries(registry)) {
    if (c.class !== 'functional' || !key.startsWith('layout.functional.group.')) continue;
    if (c.severity !== 'hard') continue;                 // derived regions stay advisory
    const p = c.parameters ?? {};
    if (typeof p.region !== 'string' || !p.region) continue;
    let pts: [number, number][];
    try {
      pts = JSON.parse(p.region) as [number, number][];
    } catch {
      continue;
    }
    if (!Array.isArray(pts) || pts.length < 3) continue;
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    // clamped to the outline: a region may be stated slightly past the edge
    const r = {
      minX: Math.max(Math.min(...xs), ob.minX + inset), maxX: Math.min(Math.max(...xs), ob.maxX - inset),
      minY: Math.max(Math.min(...ys), ob.minY + inset), maxY: Math.min(Math.max(...ys), ob.maxY - inset),
    };
    const id = key.slice('layout.functional.group.'.length);
    for (const ref of strs(p.members)) {
      const comp = byRef.get(ref);
      if (!comp || !movable.has(comp.id) || comp.attributes.locked) continue;
      const cur = byId.get(comp.id);
      const at = cur ? cur.at : comp.at;
      // the part occupies pads and body, not its courtyard: a module whose
      // courtyard fuses an antenna keep-out would never fit any region
      const pads = comp.pads.length ? bboxOf(comp.pads.map((q) => q.copper)) : null;
      const body = comp.footprint.body ? bbox(comp.footprint.body) : null;
      const local = pads && body
        ? { minX: Math.min(pads.minX, body.minX), maxX: Math.max(pads.maxX, body.maxX), minY: Math.min(pads.minY, body.minY), maxY: Math.max(pads.maxY, body.maxY) }
        : pads ?? body;
      if (!local) continue;
      const shift = { x: at.x - comp.at.x, y: at.y - comp.at.y };
      const eb = { minX: local.minX + shift.x, maxX: local.maxX + shift.x, minY: local.minY + shift.y, maxY: local.maxY + shift.y };
      const w = eb.maxX - eb.minX, h = eb.maxY - eb.minY;
      // a part larger than its region cannot be contained; centre it and say so
      if (w > r.maxX - r.minX || h > r.maxY - r.minY) {
        notes.push(`${ref} (${(w / 1e6).toFixed(1)} x ${(h / 1e6).toFixed(1)} mm) does not fit region ${id}; left where it is`);
        continue;
      }
      const dx = clamp(eb.minX, r.minX, r.maxX - w) - eb.minX;
      const dy = clamp(eb.minY, r.minY, r.maxY - h) - eb.minY;
      if (Math.abs(dx) < 10_000 && Math.abs(dy) < 10_000) continue;
      byId.set(comp.id, { id: comp.id, at: { x: Math.round(at.x + dx), y: Math.round(at.y + dy) }, rotation: cur?.rotation ?? comp.rotation, side: cur?.side ?? comp.attributes.side });
      notes.push(`${ref} moved ${(Math.hypot(dx, dy) / 1e6).toFixed(1)} mm into region ${id}`);
    }
  }
  return { placements: [...byId.values()], notes };
}

/** Stage 2 rule: a movable part whose extent lies inside the copper-to-edge clearance is moved the least distance back inside the outline. Wrapped placers do not all know the rule (B4: pyplacer parked parts 0.2 mm from the edge and the board was refused). A part pushed in may then overlap a neighbour; the placement gate judges that. */
export function legalizeEdge(design: PcbDesign, movable: Set<string>, placements: PlacedComponent[]): LegalizeResult {
  const byId = new Map(placements.map((p) => [p.id, p]));
  const notes: string[] = [];
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  for (const comp of design.components) {
    if (!movable.has(comp.id) || comp.attributes.locked) continue;
    // mounting holes sit where the mechanics put them, at the edge included; the keepout stage leaves them alone too
    if (comp.pads.every((pad) => pad.type === 'np_thru_hole') || /^H\d/.test(comp.reference)) continue;
    const e0 = extent(comp);
    if (!e0) continue;
    const placed = byId.get(comp.id);
    const at = placed ? { ...placed.at } : { ...comp.at };
    // the extent has to follow the part's rotation as well as its position: translating
    // an unrotated extent misreads a turned part's edges and shoves it by centimetres
    const dRot = placed ? normMdeg(placed.rotation - comp.rotation) : 0;
    const eb = bbox(placed ? placeLocal(translate(e0, -comp.at.x, -comp.at.y), placed.at, dRot) : e0);
    const fx = eb.minX < ob.minX + inset ? ob.minX + inset - eb.minX : eb.maxX > ob.maxX - inset ? ob.maxX - inset - eb.maxX : 0;
    const fy = eb.minY < ob.minY + inset ? ob.minY + inset - eb.minY : eb.maxY > ob.maxY - inset ? ob.maxY - inset - eb.maxY : 0;
    // the file's micrometre rounding must not read as a new shortfall on the next pass; the 250 µm margin covers it
    if (Math.abs(fx) <= 10_000 && Math.abs(fy) <= 10_000) continue;
    byId.set(comp.id, { id: comp.id, at: { x: Math.round(at.x + fx), y: Math.round(at.y + fy) }, rotation: placed?.rotation ?? comp.rotation, side: placed?.side ?? comp.attributes.side });
    notes.push(`${comp.reference} moved ${(Math.hypot(fx, fy) / 1e6).toFixed(2)} mm in from the board edge`);
  }
  return { placements: [...byId.values()], notes };
}

/**
 * Functional blocks (RFC 11 §7.7, implementation spec §7.2a), the
 * deterministic part: the design's subsystem partition (docs/SUBSYSTEMS.md
 * headings, the schematic intent's `group` per part) becomes one block per
 * subsystem with an anchor, members, a signal-flow region, and a spread
 * budget. No model call; the compiler (Phase 4) may only add roles or propose
 * a split/merge on top of this.
 */
import type { PcbDesign, ComponentInstance } from '../ir/types.js';
import type { Polygon } from '../ir/geometry.js';
import { area, bbox, bboxOf } from '../ir/geometry.js';
import type { Constraint } from '../../memory/constraints.js';

export interface Block {
  /** Slug of the subsystem heading; `unassigned` for parts no subsystem claims. */
  id: string;
  title: string;
  /** Component id of the anchor (the block's main IC, else its largest part). */
  anchor: string | null;
  /** Component ids, anchor included. */
  members: string[];
  /** Signal-flow slot on the board; null when no connector constrains the order. */
  region: Polygon | null;
  spreadBudgetNm: number;
  /** Why this block has no region or anchor, for the intent report. */
  notes: string[];
}

/** An attachment, as far as block membership is concerned. */
export interface AttachmentHint {
  ref: string;
  /** Refdes, or `REF.PIN`. */
  to: string;
  maxDistanceNm: number;
}

export interface DeriveInput {
  design: PcbDesign;
  /** docs/SUBSYSTEMS.md text; `## Heading` per subsystem. */
  subsystemsMd?: string | null;
  /** schematic.intent.json: parts carry `group` naming a heading. */
  schematicIntent?: { parts: { ref: string; group?: string }[]; hints?: { groupOrder?: string[] } } | null;
  /**
   * Attachments the intent states, so a part can be moved to the block it is
   * electrically tied to rather than the one it was drawn on.
   */
  attachments?: AttachmentHint[];
  /** Below this, an attachment is close enough to decide membership. Default 15 mm. */
  attachmentReassignNm?: number;
}

export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
}

export function subsystemHeadings(md: string | null | undefined): string[] {
  if (!md) return [];
  return [...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim());
}

const CONNECTOR_REF = /^(J|P|CON|X|USB|SW)\d/i;

export function isConnector(c: ComponentInstance): boolean {
  return c.semanticRoles.includes('connector') || CONNECTOR_REF.test(c.reference) || /Connector|USB|Jack|Header|Socket/i.test(c.footprint.libId);
}

function extentPoly(c: ComponentInstance): Polygon | null {
  if (c.footprint.courtyard) return c.footprint.courtyard;
  if (!c.pads.length) return null;
  const b = bboxOf(c.pads.map((p) => p.copper));
  return { outer: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], holes: [] };
}

function extentArea(c: ComponentInstance): number {
  const p = extentPoly(c);
  return p ? Math.abs(area(p)) : 0;
}

/** An edge connector sits within 3 mm of the outline's bounding box. */
function isEdgeConnector(c: ComponentInstance, design: PcbDesign): boolean {
  if (!isConnector(c)) return false;
  const b = bbox(design.board.outline);
  const e = extentPoly(c);
  if (!e) return false;
  const eb = bbox(e);
  const tol = 3_000_000;
  return eb.minX - b.minX < tol || b.maxX - eb.maxX < tol || eb.minY - b.minY < tol || b.maxY - eb.maxY < tol;
}

export function deriveBlocks(input: DeriveInput): Block[] {
  const { design } = input;
  const headings = subsystemHeadings(input.subsystemsMd);
  const order = input.schematicIntent?.hints?.groupOrder?.length ? input.schematicIntent.hints.groupOrder : headings;
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const groupOf = new Map<string, string>(); // component id -> heading
  const headingByKey = new Map(headings.map((h) => [h.toLowerCase(), h]));
  for (const part of input.schematicIntent?.parts ?? []) {
    const c = byRef.get(part.ref);
    if (!c || !part.group) continue;
    const h = headingByKey.get(part.group.trim().toLowerCase()) ?? part.group.trim();
    groupOf.set(c.id, h);
  }
  // nets per component and the pad->component map, for anchor selection and connector weighting
  const compOfPad = new Map<string, string>();
  for (const c of design.components) for (const p of c.pads) compOfPad.set(p.id, c.id);
  const netsOf = new Map<string, Set<string>>();
  for (const n of design.nets) {
    if (n.padIds.length < 2) continue;
    for (const pid of n.padIds) {
      const cid = compOfPad.get(pid);
      if (!cid) continue;
      if (!netsOf.has(cid)) netsOf.set(cid, new Set());
      netsOf.get(cid)!.add(n.id);
    }
  }
  const sharedNets = (a: string, b: string): number => {
    const na = netsOf.get(a), nb = netsOf.get(b);
    if (!na || !nb) return 0;
    let k = 0;
    for (const n of na) if (nb.has(n)) k++;
    return k;
  };
  const titles = [...order];
  for (const h of groupOf.values()) if (!titles.includes(h)) titles.push(h);
  const blocks: Block[] = [];
  const claimed = new Set<string>();
  for (const title of titles) {
    const members = design.components.filter((c) => groupOf.get(c.id) === title).map((c) => c.id);
    if (!members.length) continue;
    for (const m of members) claimed.add(m);
    blocks.push(makeBlock(slugify(title), title, members, design, sharedNets));
  }
  reassignByAttachment(blocks, design, input);
  const unassigned = design.components.filter((c) => !claimed.has(c.id)).map((c) => c.id);
  if (unassigned.length) {
    const b = makeBlock('unassigned', 'unassigned', unassigned, design, sharedNets);
    b.notes.push(`${unassigned.length} part(s) name no subsystem: ${unassigned.map((id) => design.components.find((c) => c.id === id)!.reference).join(', ')}`);
    blocks.push(b);
  }
  assignRegions(blocks, design, sharedNets);
  return blocks;
}

/**
 * Move a part to the block holding the part it is attached to.
 *
 * `group` in the schematic intent is the sheet a part was drawn on, and a
 * schematic sheet grouping is not a floorplan grouping. On esp32-amp, CP1 is the
 * class-D bulk capacitor for U3 but is filed under *Power Input*: the region
 * constraint is hard and the 12 mm attachment is not, so CP1 ends up 24 mm from
 * the pin it serves and the switching loop measures 94 mm² against a 40 mm²
 * budget — the most important physical relationship on that board, lost to a
 * drawing convention.
 *
 * A tight attachment is the stronger statement. Only tight ones move a part:
 * a 12 mm bulk cap is saying "I belong beside this pin", a 30 mm one is not.
 * Anchors never move — they define their block — and a part is moved at most
 * once, so two attachments cannot fight over it.
 */
function reassignByAttachment(blocks: Block[], design: PcbDesign, input: DeriveInput): void {
  const atts = input.attachments ?? [];
  if (!atts.length) return;
  const limit = input.attachmentReassignNm ?? 15_000_000;
  const idOf = new Map(design.components.map((c) => [c.reference, c.id]));
  const blockOf = new Map<string, Block>();
  for (const b of blocks) for (const m of b.members) blockOf.set(m, b);
  const anchors = new Set(blocks.map((b) => b.anchor).filter((a): a is string => !!a));

  for (const a of [...atts].sort((x, y) => x.maxDistanceNm - y.maxDistanceNm || x.ref.localeCompare(y.ref))) {
    if (a.maxDistanceNm > limit) continue;
    const id = idOf.get(a.ref), targetId = idOf.get(a.to.split('.')[0] ?? '');
    if (!id || !targetId || anchors.has(id)) continue;
    const from = blockOf.get(id), to = blockOf.get(targetId);
    if (!from || !to || from === to) continue;
    from.members = from.members.filter((m) => m !== id);
    to.members.push(id);
    blockOf.set(id, to);
    to.notes.push(`${a.ref} moved here from ${from.id}: attached to ${a.to} within ${(a.maxDistanceNm / 1e6).toFixed(1)} mm`);
  }
  // a block emptied by reassignment is not a block
  for (let i = blocks.length - 1; i >= 0; i--) if (!blocks[i]!.members.length) blocks.splice(i, 1);
}

function makeBlock(id: string, title: string, members: string[], design: PcbDesign, sharedNets: (a: string, b: string) => number): Block {
  const comps = members.map((id) => design.components.find((c) => c.id === id)!);
  // anchor: the IC (>= 8 pads, not a connector) with the most member connections, else the largest part
  const ics = comps.filter((c) => c.pads.length >= 8 && !isConnector(c));
  const score = (c: ComponentInstance) => members.reduce((a, m) => (m === c.id ? a : a + sharedNets(c.id, m)), 0);
  let anchor: ComponentInstance | undefined;
  const notes: string[] = [];
  if (ics.length) anchor = [...ics].sort((a, b) => score(b) - score(a) || extentArea(b) - extentArea(a) || a.reference.localeCompare(b.reference))[0];
  else {
    anchor = [...comps].sort((a, b) => extentArea(b) - extentArea(a) || a.reference.localeCompare(b.reference))[0];
    if (anchor) notes.push(`no IC in the block; ${anchor.reference} (largest part) anchors it`);
  }
  const spread = Math.round(1.5 * Math.sqrt(comps.reduce((a, c) => a + extentArea(c), 0)));
  return { id, title, anchor: anchor?.id ?? null, members, region: null, spreadBudgetNm: spread, notes };
}

/**
 * Signal flow: blocks touching edge connectors take slots left to right in the
 * order of the mean x of the connectors they touch; blocks touching none sit
 * between them in subsystem order. Regions are equal-width vertical slots
 * across the outline. With no edge connector at all, every region is null.
 */
function assignRegions(blocks: Block[], design: PcbDesign, sharedNets: (a: string, b: string) => number): void {
  const edge = design.components.filter((c) => isEdgeConnector(c, design));
  if (!edge.length || blocks.length < 2) {
    for (const b of blocks) if (!edge.length) b.notes.push('no edge connector on the board; no signal-flow region assigned');
    return;
  }
  const weightX = new Map<string, number | null>();
  for (const b of blocks) {
    let w = 0, wx = 0;
    for (const m of b.members) for (const e of edge) {
      if (b.members.includes(e.id)) continue;
      const k = sharedNets(m, e.id);
      if (k) {
        w += k;
        wx += k * e.at.x;
      }
    }
    // a block that contains an edge connector is anchored where that connector is
    for (const e of edge) if (b.members.includes(e.id)) {
      w += 1;
      wx += e.at.x;
    }
    weightX.set(b.id, w ? wx / w : null);
  }
  const xs = [...weightX.values()].filter((v): v is number => v !== null);
  const mid = xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : 0;
  const ordered = [...blocks].map((b, i) => ({ b, i, x: weightX.get(b.id) ?? mid })).sort((p, q) => p.x - q.x || p.i - q.i);
  const ob = bbox(design.board.outline);
  const margin = design.board.rules.copperEdgeClearanceNm + 1_000_000;
  const x0 = ob.minX + margin, x1 = ob.maxX - margin, y0 = ob.minY + margin, y1 = ob.maxY - margin;
  const slot = (x1 - x0) / ordered.length;
  ordered.forEach(({ b }, i) => {
    if (b.id === 'unassigned') return;
    const sx0 = Math.round(x0 + i * slot), sx1 = Math.round(x0 + (i + 1) * slot);
    b.region = { outer: [{ x: sx0, y: y0 }, { x: sx1, y: y0 }, { x: sx1, y: y1 }, { x: sx0, y: y1 }], holes: [] };
  });
}

/** Registry entries: one `layout.functional.group.<slug>` per block (spec §7.1); region as a JSON string. */
export function blocksToConstraints(blocks: Block[], design: PcbDesign, source = 'blocks'): Record<string, Constraint> {
  const ref = (id: string) => design.components.find((c) => c.id === id)?.reference ?? id;
  const out: Record<string, Constraint> = {};
  for (const b of blocks) {
    if (b.id === 'unassigned') continue;
    out[`layout.functional.group.${b.id}`] = {
      source,
      affects: ['board'],
      class: 'functional',
      severity: 'soft',
      scope: { refs: b.members.map(ref) },
      parameters: { anchor: b.anchor ? ref(b.anchor) : '', members: b.members.map(ref), region: b.region ? JSON.stringify(b.region.outer.map((p) => [p.x, p.y])) : '', spread_budget_nm: b.spreadBudgetNm },
      priority: 50,
      confidence: 1,
      approvedBy: source,
    };
  }
  return out;
}

/** Board edges, in the order a tie is broken (a middle slot is equidistant from north and south). */
export const EDGE_ORDER = ['south', 'north', 'west', 'east'] as const;
export type BoardEdge = (typeof EDGE_ORDER)[number];

/**
 * A connector proper: something a cable, plug or wire reaches from off-board.
 *
 * Deliberately narrower than `isConnector`, whose refdes pattern also catches
 * `SW` so that `partKind` classifies a push-button as a connector. A button
 * belongs beside the IC it interrupts, not on the perimeter, and a mounting
 * hole, test point or jumper belongs wherever the board needs it.
 */
export function wantsBoardEdge(c: ComponentInstance): boolean {
  if (/Button|Switch|MountingHole|TestPoint|Jumper/i.test(c.footprint.libId)) return false;
  if (/^(SW|S|H|MH|TP|JP)\d/i.test(c.reference)) return false;
  return c.semanticRoles.includes('connector') || /^(J|P|CON|X|USB)\d/i.test(c.reference) || /Connector|USB|Jack|Header|Socket|TerminalBlock/i.test(c.footprint.libId);
}

/**
 * The edge each connector belongs on, for the connectors nobody placed.
 *
 * "A connector sits on a board edge" is a fact about the part, not a
 * preference, but the only way to state it used to be `placement.fixed[].edge`
 * in a hand-written intent file. The classifier tags a connector `mechanical`
 * (`partKind` -> `critical.ts`), which orders it into the first placement phase
 * and nothing more, so a board with no intent file had its USB receptacle
 * packed into the middle like a resistor — 2.7 mm of bare board in front of it,
 * where no plug can reach.
 *
 * The edge comes from the signal-flow regions `assignRegions` has already
 * computed: they are equal-width vertical slots across the outline, so the
 * leftmost block's centroid is nearest the west edge, the rightmost's nearest
 * the east, and a block in between is nearest north or south. A tie goes to
 * whichever of those edges carries the fewest connectors so far, then to
 * `EDGE_ORDER` — deterministic, and it spreads them instead of stacking them.
 *
 * Needs regions, so it yields nothing for a run without blocks — and nothing
 * for a connector in the `unassigned` block, which never gets a region. A
 * connector that names no subsystem therefore keeps today's behaviour; say
 * where it goes in the intent file, or give it a subsystem. Never overwrites:
 * a `fixed` position or an `edge` already in the registry wins, as does a part
 * locked in KiCad.
 */
export function connectorEdgeConstraints(
  blocks: Block[],
  design: PcbDesign,
  existing: Record<string, Constraint> = {},
  source = 'blocks',
): Record<string, Constraint> {
  const out: Record<string, Constraint> = {};
  const ob = bbox(design.board.outline);
  const byId = new Map(design.components.map((c) => [c.id, c]));
  // count what the registry already spoke for, so a derived edge spreads away from it
  const taken: Record<BoardEdge, number> = { south: 0, north: 0, west: 0, east: 0 };
  for (const [k, c] of Object.entries(existing)) {
    const e = c.parameters?.edge;
    if (k.startsWith('layout.mechanical.edge.') && typeof e === 'string' && e in taken) taken[e as BoardEdge] += 1;
  }
  for (const b of blocks) {
    if (!b.region) continue;
    const rb = bbox(b.region);
    const cx = (rb.minX + rb.maxX) / 2, cy = (rb.minY + rb.maxY) / 2;
    const gap: Record<BoardEdge, number> = { south: ob.maxY - cy, north: cy - ob.minY, west: cx - ob.minX, east: ob.maxX - cx };
    for (const id of b.members) {
      const c = byId.get(id);
      if (!c || c.attributes.locked || !wantsBoardEdge(c)) continue;
      if (existing[`layout.mechanical.edge.${c.reference}`] || existing[`layout.mechanical.fixed.${c.reference}`]) continue;
      const edge = [...EDGE_ORDER].sort((p, q) => gap[p] - gap[q] || taken[p] - taken[q] || EDGE_ORDER.indexOf(p) - EDGE_ORDER.indexOf(q))[0]!;
      taken[edge] += 1;
      // Where along that edge: the block's own region centre. Without it the
      // part keeps whatever coordinate the bootstrap grid gave it, which is
      // meaningless and lands it on whatever the anchors stage puts there next.
      const along = Math.round(edge === 'west' || edge === 'east' ? cy : cx);
      out[`layout.mechanical.edge.${c.reference}`] = {
        source,
        affects: ['board'],
        class: 'mechanical',
        severity: 'hard',
        scope: { refs: [c.reference] },
        parameters: { edge, orientation: 'outward', along_nm: along },
        priority: 70, // below a user-authored edge (90); it never competes anyway, the key is skipped
        confidence: 0.8,
        approvedBy: 'rule',
      };
    }
  }
  return out;
}

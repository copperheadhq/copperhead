import type { Bounds } from '../sexp.js';
import { knum, type PlacementModel, type EmitSymbol } from '../emit.js';
import { powerSymbolSource, pwrFlagSource, type ResolvedSymbol, type DraftPin } from './symsource.js';
import type { SchematicIntent, IntentNet, IntentPart, ValidatedIntent } from './ir.js';

/**
 * The rule-based deterministic drafting engine (design D1/D2). All geometry is
 * computed in integer multiples of the 1.27mm grid, so every pin lands on-grid
 * by construction. No randomness, no clock, no environment-dependent ordering:
 * identical IR yields an identical placement model on every machine.
 */

/** The grid. Every symbol origin and wire endpoint is an integer multiple. */
const U = 1.27;
/** Stub length from a pin to its label/power symbol, in grid units. */
const STUB = 2;
/** Cell margin around a symbol body (room for stubs, labels, text), in units. */
const MARGIN = 6;
/** Vertical gap between rows and horizontal channel between columns, units. */
const ROW_GAP = 4;
const CHANNEL = 8;
/** Gap between group boxes, units. */
const GROUP_GAP = 8;
/** Local nets up to this many endpoints may be wired (design D2). */
const MAX_WIRED_ENDPOINTS = 4;
/** Wire-span budget in mm beyond which a net becomes labels. */
const MAX_WIRE_SPAN = 50.8;
/** Label text metrics, matching the legibility checker's conservative box. */
const LABEL_HEIGHT = 1.27;
const LABEL_ADVANCE = 0.6;
/** How far a colliding label may ride its stub outward, in grid units. */
const MAX_LABEL_NUDGE = 4;
/**
 * Fraction of labels allowed to still overlap a foreign net's label text after
 * the de-collision pass has done what it can.
 *
 * Overlapping text boxes and coincident label POINTS are different failures and
 * are treated differently. A shared point merges two nets (`findMergedNets`) and
 * is always refused — the drawn netlist would not be the IR's. Overlapping text
 * is a legibility defect: the sheet is harder to read, the netlist is correct.
 * Refusing a whole draft over the second kind is what turned a real placement
 * bug into a pipeline that could not finish, so a small budget is tolerated,
 * counted, and reported rather than gated.
 */
const LABEL_OVERLAP_BUDGET = 0.02;

const ceilU = (mm: number): number => Math.ceil(mm / U - 1e-9);
const grid = (units: number): number => Math.round(units) * U;

/**
 * Two coordinates are the same POINT iff they emit identically: comparisons and
 * map keys go through `knum`, the emitter's rounding, because KiCad's
 * connectivity sees the rounded file, not the engine's float dust —
 * 13.969999999999999 and 13.97 are one coordinate on the sheet. Raw float keys
 * here would let two distinct nets whose labels differ by dust but emit to the
 * same point evade the merged-net refusal.
 */
const sameCoord = (a: number, b: number): boolean => knum(a) === knum(b);
const pointKey = (x: number, y: number): string => `${knum(x)},${knum(y)}`;

/** Standard landscape sheets, smallest first, for content-derived paper. */
const PAPERS: { name: string; w: number; h: number }[] = [
  { name: 'A5', w: 210, h: 148 },
  { name: 'A4', w: 297, h: 210 },
  { name: 'A3', w: 420, h: 297 },
  { name: 'A2', w: 594, h: 420 },
  { name: 'A1', w: 841, h: 594 },
  { name: 'A0', w: 1189, h: 841 },
];
const FRAME = 10;
const TITLE_STRIP = 30;

export type NetClass = 'rail' | 'ground' | 'signal';

export interface SchematicDraftReport {
  groups: { name: string; members: string[] }[];
  netClasses: { name: string; class: NetClass; overridden: boolean }[];
  wireCount: number;
  labelCount: number;
  pwrFlags: string[];
  noConnects: number;
  paper: string;
  notes: string[];
  /**
   * Points where labels of two or more distinct nets landed together, merging
   * them into one net in the emitted sheet. Non-empty means the drawing does
   * not implement the IR, so the caller must refuse the draft.
   */
  mergedNets: { x: number; y: number; nets: string[]; via?: 'labels' | 'wires' }[];
  /**
   * Labels whose TEXT still overlaps a foreign net's label after de-collision.
   * The netlist is correct — these are legibility defects, tolerated up to
   * `LABEL_OVERLAP_BUDGET` and always reported. Never a reason to refuse.
   */
  labelOverlaps: { x: number; y: number; nets: string[] }[];
  /** Whether `labelOverlaps` exceeded the tolerated fraction of all labels. */
  labelOverlapBudgetExceeded: boolean;
}

/**
 * Points carrying labels for two or more distinct nets.
 *
 * Co-located labels are not a cosmetic overlap: KiCad resolves them to a single
 * net and reports `Both A and B are attached to the same items; A will be used
 * in the netlist` — as a *warning*. A live run drew ISET (charge-current
 * program) and NTC (thermistor input) onto one node of a BQ24040 that way,
 * which would have shipped a board whose charge current is not set by its
 * programming resistor and whose temperature cutoff does not work.
 *
 * The engine computes every coordinate, so this is the engine's to catch, and
 * it is strictly worse than the failures already gated: an unreadable sheet
 * stops the pipeline loudly, a merged net flows quietly into layout and
 * fabrication outputs.
 */
export function findMergedNets(
  labels: { name: string; x: number; y: number }[],
): { x: number; y: number; nets: string[] }[] {
  const byPoint = new Map<string, Set<string>>();
  for (const l of labels) {
    const key = pointKey(l.x, l.y);
    const at = byPoint.get(key) ?? new Set<string>();
    at.add(l.name);
    byPoint.set(key, at);
  }
  return [...byPoint.entries()]
    .filter(([, nets]) => nets.size > 1)
    .map(([key, nets]) => {
      const [x, y] = key.split(',').map(Number);
      return { x: x!, y: y!, nets: [...nets].sort() };
    })
    .sort((a, b) => a.nets[0]!.localeCompare(b.nets[0]!));
}

/** True when (px,py) lies on the horizontal/vertical segment, endpoints
 * included. The same dust tolerance as `sameCoord` for the fixed coordinate;
 * the along-segment range check uses a plain epsilon. */
const SEG_EPS = 0.005;
const pointOnSeg = (
  px: number,
  py: number,
  s: { x1: number; y1: number; x2: number; y2: number },
): boolean => {
  if (sameCoord(s.x1, s.x2)) {
    return sameCoord(px, s.x1) && py >= Math.min(s.y1, s.y2) - SEG_EPS && py <= Math.max(s.y1, s.y2) + SEG_EPS;
  }
  if (sameCoord(s.y1, s.y2)) {
    return sameCoord(py, s.y1) && px >= Math.min(s.x1, s.x2) - SEG_EPS && px <= Math.max(s.x1, s.x2) + SEG_EPS;
  }
  return false;
};

/**
 * Cross-net wire contact is a merged net the co-located-label check cannot
 * see: KiCad joins wires at coincident endpoints and at an endpoint on
 * another wire's interior, whatever the labels say. The lemondrop run routed
 * a local net's trunk down a column of neighbouring stub ends and shorted the
 * crystal drive onto TOUCH_IRQ exactly this way (I22, #204) — ERC demoted it
 * to a warning and it would have flowed into layout. The router now avoids
 * foreign contact; this check gates whatever geometry any pass produces, so
 * a merge can never again leave the engine silently. A label whose anchor
 * sits on a foreign net's wire attaches to that wire in KiCad and is the
 * same defect.
 */
export function findWireContactMerges(
  wires: { x1: number; y1: number; x2: number; y2: number; net: string }[],
  labels: { name: string; x: number; y: number }[],
): { x: number; y: number; nets: string[] }[] {
  const out = new Map<string, { x: number; y: number; nets: string[] }>();
  const add = (x: number, y: number, a: string, b: string): void => {
    if (a === b) return;
    const nets = [a, b].sort();
    const key = `${nets[0]}/${nets[1]}@${pointKey(x, y)}`;
    if (!out.has(key)) out.set(key, { x, y, nets });
  };
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const a = wires[i]!;
      const b = wires[j]!;
      if (a.net === b.net) continue;
      if (pointOnSeg(a.x1, a.y1, b)) add(a.x1, a.y1, a.net, b.net);
      if (pointOnSeg(a.x2, a.y2, b)) add(a.x2, a.y2, a.net, b.net);
      if (pointOnSeg(b.x1, b.y1, a)) add(b.x1, b.y1, a.net, b.net);
      if (pointOnSeg(b.x2, b.y2, a)) add(b.x2, b.y2, a.net, b.net);
    }
  }
  for (const l of labels) {
    for (const w of wires) {
      if (w.net === l.name) continue;
      if (pointOnSeg(l.x, l.y, w)) add(l.x, l.y, l.name, w.net);
    }
  }
  return [...out.values()].sort(
    (a, b) => a.nets[0]!.localeCompare(b.nets[0]!) || a.x - b.x || a.y - b.y,
  );
}

interface Placed {
  part: IntentPart;
  sym: ResolvedSymbol;
  /** Origin, mm (grid multiple). */
  x: number;
  y: number;
  body: Bounds; // schematic space, absolute
  cellW: number; // units
  cellH: number; // units
}

const bodyBoundsOf = (sym: ResolvedSymbol): Bounds => {
  if (sym.body) return sym.body;
  const xs = sym.pins.map((p) => p.x);
  const ys = sym.pins.map((p) => p.y);
  if (!xs.length) return { minX: -U, minY: -U, maxX: U, maxY: U };
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

/** Pin connection point in schematic space for a part placed at (x, y), rot 0. */
const pinAt = (p: Placed, pin: DraftPin): { x: number; y: number } => ({ x: p.x + pin.x, y: p.y - pin.y });

/** Outward direction of a pin (away from the body), schematic space. */
function outward(pin: DraftPin): { dx: number; dy: number } {
  // pin angle points from the connection point toward the body (symbol space,
  // Y-up); outward is the opposite, with Y flipped into schematic space.
  const a = ((pin.angle % 360) + 360) % 360;
  if (a === 0) return { dx: -1, dy: 0 };
  if (a === 180) return { dx: 1, dy: 0 };
  if (a === 90) return { dx: 0, dy: 1 };
  return { dx: 0, dy: -1 };
}

function classifyNet(net: IntentNet, pinsOf: (ep: string) => DraftPin | null): { cls: NetClass; overridden: boolean } {
  if (net.kind === 'power') return { cls: 'rail', overridden: true };
  if (net.kind === 'ground') return { cls: 'ground', overridden: true };
  if (net.kind === 'signal') return { cls: 'signal', overridden: true };
  const touchesPower = net.pins.some((ep) => {
    const p = pinsOf(ep);
    return p !== null && (p.etype === 'power_in' || p.etype === 'power_out');
  });
  if (!touchesPower) return { cls: 'signal', overridden: false };
  return { cls: /gnd|vss/i.test(net.name) ? 'ground' : 'rail', overridden: false };
}

const boundsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.minX < b.maxX - 0.01 && a.maxX > b.minX + 0.01 && a.minY < b.maxY - 0.01 && a.maxY > b.minY + 0.01;

/**
 * The box a label's text occupies, matching the legibility checker's
 * conservative metrics. Shared by the de-collision pass and the overlap report
 * so "clear" means one thing in the engine.
 */
const labelTextBox = (name: string, x: number, y: number, rot: number): Bounds => {
  const w = Math.max(1, name.length) * LABEL_ADVANCE * LABEL_HEIGHT;
  const h = LABEL_HEIGHT / 2;
  return rot === 180
    ? { minX: x - w, minY: y - h, maxX: x, maxY: y + h }
    : { minX: x, minY: y - h, maxX: x + w, maxY: y + h };
};

/**
 * Pairs of labels naming DIFFERENT nets whose text boxes overlap.
 *
 * Distinct from `findMergedNets`, which looks for a shared label *point*. A
 * shared point is electrical — KiCad fuses the nets. Overlapping text is
 * cosmetic: the sheet reads badly, the netlist is right. Reported one entry per
 * colliding label position, nets sorted, so the same pair is not listed twice.
 */
export function findLabelOverlaps(
  labels: { name: string; x: number; y: number; rot: number }[],
): { x: number; y: number; nets: string[] }[] {
  const out = new Map<string, { x: number; y: number; nets: Set<string> }>();
  const boxes = labels.map((l) => labelTextBox(l.name, l.x, l.y, l.rot));
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!;
      const b = labels[j]!;
      if (a.name === b.name) continue;
      // an exact coincidence is a merged net, reported by findMergedNets; do
      // not also count it here or one fault reads as two
      if (sameCoord(a.x, b.x) && sameCoord(a.y, b.y)) continue;
      if (!boundsOverlap(boxes[i]!, boxes[j]!)) continue;
      for (const [l, other] of [[a, b], [b, a]] as const) {
        const key = pointKey(l.x, l.y);
        const e = out.get(key) ?? { x: l.x, y: l.y, nets: new Set<string>([l.name]) };
        e.nets.add(other.name);
        out.set(key, e);
      }
    }
  }
  return [...out.values()]
    .map((e) => ({ x: e.x, y: e.y, nets: [...e.nets].sort() }))
    .sort((a, b) => a.nets[0]!.localeCompare(b.nets[0]!) || a.x - b.x || a.y - b.y);
}

const segCrossesBody = (x1: number, y1: number, x2: number, y2: number, b: Bounds): boolean => {
  const inX = Math.max(Math.min(x1, x2), b.minX) < Math.min(Math.max(x1, x2), b.maxX) - 0.01;
  const inY = Math.max(Math.min(y1, y2), b.minY) < Math.min(Math.max(y1, y2), b.maxY) - 0.01;
  if (x1 === x2) return x1 > b.minX + 0.01 && x1 < b.maxX - 0.01 && inY;
  if (y1 === y2) return y1 > b.minY + 0.01 && y1 < b.maxY - 0.01 && inX;
  return inX && inY; // conservative for diagonals (the engine never draws them)
};

export function draftSchematicPlacement(validated: ValidatedIntent, projectName: string, today: string): { model: PlacementModel; report: SchematicDraftReport } {
  const { intent, symbols, docGroups } = validated;
  const notes: string[] = [];

  // ---------- net classification (deterministic, visible in the report) ----------
  const partByRef = new Map(intent.parts.map((p) => [p.ref, p]));
  const pinLookup = (ep: string): DraftPin | null => {
    const m = /^([^.]+)\.(.+)$/.exec(ep);
    if (!m) return null;
    const sym = symbols.get(m[1]!);
    return sym?.pins.find((p) => p.number === m[2]) ?? null;
  };
  const netClasses = new Map<string, { cls: NetClass; overridden: boolean }>();
  for (const net of intent.nets) netClasses.set(net.name, classifyNet(net, pinLookup));
  const powerNets = intent.nets.filter((n) => netClasses.get(n.name)!.cls !== 'signal');
  const signalNets = intent.nets.filter((n) => netClasses.get(n.name)!.cls === 'signal');

  // ---------- reductions: decoupling caps and connectors ----------
  const isCap = (p: IntentPart): boolean => /^Device:C(_|$)|^Device:C$/.test(p.libId) || p.libId === 'Device:C_Polarized';
  const railsOf = (ref: string): string[] =>
    powerNets
      .filter((net) => netClasses.get(net.name)!.cls === 'rail' && net.pins.some((ep) => ep.startsWith(`${ref}.`)))
      .map((net) => net.name);
  const railOf = (ref: string): string | null => railsOf(ref)[0] ?? null;
  const touchesGround = (ref: string): boolean =>
    powerNets.some((n) => netClasses.get(n.name)!.cls === 'ground' && n.pins.some((ep) => ep.startsWith(`${ref}.`)));

  const decapOwner = new Map<string, string>(); // cap ref -> owner IC ref
  for (const p of intent.parts) {
    const sym = symbols.get(p.ref)!;
    if (sym.isPower || !isCap(p) || sym.pins.length !== 2) continue;
    const rail = railOf(p.ref);
    if (!rail || !touchesGround(p.ref)) continue;
    // owner: an IC (3+ pins) on the same rail — same group first, then most
    // shared nets, then refdes order (deterministic tie-break, engine spec)
    const candidates = intent.parts
      .filter((c) => c.ref !== p.ref && (symbols.get(c.ref)?.pins.length ?? 0) >= 3 && railsOf(c.ref).includes(rail))
      .map((c) => ({
        ref: c.ref,
        sameGroup: c.group === p.group ? 1 : 0,
        shared: intent.nets.filter((n) => n.pins.some((e) => e.startsWith(`${c.ref}.`)) && n.pins.some((e) => e.startsWith(`${p.ref}.`))).length,
      }))
      .sort((a, b) => b.sameGroup - a.sameGroup || b.shared - a.shared || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
    if (candidates.length) decapOwner.set(p.ref, candidates[0]!.ref);
  }
  const isConnector = (p: IntentPart): boolean => p.libId.startsWith('Connector');

  // ---------- facing-label extents ----------
  // A labelled stub extends horizontal TEXT into the channel beside its pin:
  // the stub plus the net name at the checker's conservative advance. The base
  // column channel and group gap assume short names; two facing pins whose
  // combined names run past ~25 characters overrun them, and the de-collision
  // pass cannot help (riding a stub outward moves the text further INTO the
  // facing group). So the gaps below are widened by the facing extents, and a
  // long-named pair drafts clean by construction instead of surviving as an
  // error-severity text collision. Conservative on purpose: whether a signal
  // net is wired or labelled is decided after placement, so every signal net
  // counts here — typical names fit inside the base gaps and nothing widens.
  const signalNetOfPin = new Map<string, string>();
  for (const net of signalNets) for (const ep of net.pins) signalNetOfPin.set(ep, net.name);
  /** Every endpoint's net, power-class nets included (the idiom passes need
   * to see a chain's rail/ground end, which signalNetOfPin cannot). */
  const netByEndpoint = new Map<string, IntentNet>();
  for (const net of intent.nets) for (const ep of net.pins) netByEndpoint.set(ep, net);
  const labelExtents = (refs: string[]): { left: number; right: number } => {
    let left = 0;
    let right = 0;
    for (const ref of refs) {
      for (const pin of symbols.get(ref)?.pins ?? []) {
        const net = signalNetOfPin.get(`${ref}.${pin.number}`);
        if (!net) continue;
        const o = outward(pin);
        if (o.dx === 0) continue;
        const extent = STUB * U + Math.max(1, net.length) * LABEL_ADVANCE * LABEL_HEIGHT;
        if (o.dx === -1) left = Math.max(left, extent);
        else right = Math.max(right, extent);
      }
    }
    return { left, right };
  };
  /** Extra gap units so facing label text fits a boundary whose body-to-body
   * clearance is `baseUnits` (one unit of slack between the two texts). */
  const widenBy = (rightOfPrev: number, leftOfNext: number, baseUnits: number): number =>
    Math.max(0, ceilU(rightOfPrev + leftOfNext) + 1 - baseUnits);

  // ---------- group ordering: hints, then SUBSYSTEMS.md order, then name ----------
  const groupNames = [...new Set(intent.parts.filter((p) => !symbols.get(p.ref)!.isPower).map((p) => p.group))];
  const orderIndex = (g: string): number => {
    const hinted = intent.hints?.groupOrder?.findIndex((h) => h.toLowerCase() === g.toLowerCase());
    if (hinted !== undefined && hinted >= 0) return hinted;
    const doc = docGroups?.findIndex((h) => h.toLowerCase() === g.toLowerCase());
    if (doc !== undefined && doc >= 0) return 1000 + doc;
    return 2000;
  };
  groupNames.sort((a, b) => orderIndex(a) - orderIndex(b) || a.localeCompare(b));

  // ---------- in-group placement: layering + barycenter, integer grid ----------
  const placed = new Map<string, Placed>();
  const groupRects: { name: string; x1: number; y1: number; x2: number; y2: number }[] = [];
  const groupOf = new Map<string, string>();
  let groupX = 0; // running x origin (units) for group tiling
  let prevGroup: string | null = null; // last group that actually placed cells
  const groupExtents = new Map<string, { left: number; right: number }>();
  for (const gname of groupNames) {
    groupExtents.set(
      gname,
      labelExtents(intent.parts.filter((p) => p.group === gname && !symbols.get(p.ref)!.isPower).map((p) => p.ref)),
    );
  }

  for (const gname of groupNames) {
    // widen the gap to the previous group when facing label text needs it
    if (prevGroup !== null) {
      groupX += widenBy(groupExtents.get(prevGroup)!.right, groupExtents.get(gname)!.left, 2 * MARGIN + GROUP_GAP);
    }
    const members = intent.parts.filter(
      (p) => p.group === gname && !symbols.get(p.ref)!.isPower && !decapOwner.has(p.ref),
    );
    const caps = intent.parts.filter((p) => p.group === gname && decapOwner.has(p.ref));
    for (const p of [...members, ...caps]) groupOf.set(p.ref, gname);

    // layer assignment: connectors at depth 0; signal edges push depth forward
    const depth = new Map<string, number>(members.map((m) => [m.ref, isConnector(m) ? 0 : 1]));
    const edges: { from: string; to: string }[] = [];
    for (const net of signalNets) {
      const eps = net.pins
        .map((ep) => /^([^.]+)\./.exec(ep)?.[1] ?? '')
        .filter((r) => members.some((m) => m.ref === r));
      const uniq = [...new Set(eps)];
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const [a, b] = [uniq[i]!, uniq[j]!].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
          edges.push({ from: a!, to: b! });
        }
      }
    }
    for (let iter = 0; iter < members.length; iter++) {
      let changed = false;
      for (const e of edges) {
        const want = (depth.get(e.from) ?? 0) + 1;
        if ((depth.get(e.to) ?? 0) < want && want <= members.length) {
          depth.set(e.to, want);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const depths = [...new Set([...depth.values()])].sort((a, b) => a - b);
    const columns: string[][] = depths.map((d) => members.filter((m) => depth.get(m.ref) === d).map((m) => m.ref));

    // barycenter row ordering (two sweeps), refdes as the deterministic tie
    const rowOf = new Map<string, number>();
    columns.forEach((col) => col.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach((r, i) => rowOf.set(r, i)));
    for (let sweep = 0; sweep < 2; sweep++) {
      for (let ci = 1; ci < columns.length; ci++) {
        const col = columns[ci]!;
        const bary = (ref: string): number => {
          const neigh = edges
            .filter((e) => e.from === ref || e.to === ref)
            .map((e) => (e.from === ref ? e.to : e.from))
            .filter((o) => rowOf.has(o));
          if (!neigh.length) return rowOf.get(ref)!;
          return neigh.reduce((s, o) => s + rowOf.get(o)!, 0) / neigh.length;
        };
        col.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b, undefined, { numeric: true })).forEach((r, i) => rowOf.set(r, i));
      }
    }

    // cells: sized from body plus margins, positions snapped to the grid
    const cellDims = new Map<string, { w: number; h: number; body: Bounds }>();
    for (const m of members) {
      const b = bodyBoundsOf(symbols.get(m.ref)!);
      cellDims.set(m.ref, {
        w: ceilU(b.maxX - b.minX) + 2 * MARGIN,
        h: ceilU(b.maxY - b.minY) + 2 * MARGIN,
        body: b,
      });
    }
    let colX = groupX;
    let groupMaxY = 0;
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci]!;
      const colW = Math.max(...col.map((r) => cellDims.get(r)!.w));
      let rowY = 0;
      for (const ref of col) {
        const dims = cellDims.get(ref)!;
        const cx = colX + Math.floor(colW / 2); // shared column axis (units)
        const cy = rowY + Math.floor(dims.h / 2);
        const b = dims.body;
        // origin so the body centers on the cell center, snapped to grid
        const ox = grid(cx - Math.round((b.minX + b.maxX) / 2 / U));
        const oy = grid(cy + Math.round((b.minY + b.maxY) / 2 / U));
        const sym = symbols.get(ref)!;
        placed.set(ref, {
          part: partByRef.get(ref)!,
          sym,
          x: ox,
          y: oy,
          body: { minX: ox + b.minX, minY: oy - b.maxY, maxX: ox + b.maxX, maxY: oy - b.minY },
          cellW: dims.w,
          cellH: dims.h,
        });
        rowY += dims.h + ROW_GAP;
      }
      groupMaxY = Math.max(groupMaxY, rowY - ROW_GAP);
      const next = columns[ci + 1];
      colX += colW + CHANNEL + (next ? widenBy(labelExtents(col).right, labelExtents(next).left, 2 * MARGIN + CHANNEL) : 0);
    }

    // decoupling rows: caps in a uniform row under their owner (or the group)
    const capRefs = caps.map((c) => c.ref).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (capRefs.length) {
      let capX = groupX;
      const capY = groupMaxY + MARGIN + 4;
      for (const ref of capRefs) {
        const sym = symbols.get(ref)!;
        const b = bodyBoundsOf(sym);
        const ox = grid(capX + MARGIN);
        const oy = grid(capY + MARGIN);
        placed.set(ref, {
          part: partByRef.get(ref)!,
          sym,
          x: ox,
          y: oy,
          body: { minX: ox + b.minX, minY: oy - b.maxY, maxX: ox + b.maxX, maxY: oy - b.minY },
          cellW: ceilU(b.maxX - b.minX) + 2 * MARGIN,
          cellH: ceilU(b.maxY - b.minY) + 2 * MARGIN,
        });
        capX += ceilU(b.maxX - b.minX) + 2 * MARGIN;
      }
      groupMaxY = capY + 2 * MARGIN + 6;
    }

    // ---------- idiom micro-templates and the alignment pass (7.5/7.5a) ----------
    // Column placement is correct but reads machine-made for the small
    // structures a human drafter draws by reflex: a pull-up sits directly on
    // the pin it pulls with its rail above, a series RC hangs as one straight
    // vertical run, crystal load caps mirror about their crystal. Two passes
    // rearrange exactly those shapes after column placement, both no-ops
    // unless the textbook topology is present, and both collision-checked so
    // a failed fit falls back to the column position rather than overlapping.
    const inGroup = new Set(members.map((m) => m.ref));
    const idiomPlaced = new Set<string>();
    const CHAIN_GAP = 4 * U;
    /** The two pins of a vertically-pinned two-lead part, or null. */
    const vertPins = (ref: string): { top: DraftPin; bot: DraftPin } | null => {
      const pins = symbols.get(ref)?.pins ?? [];
      if (pins.length !== 2) return null;
      const top = pins.find((p) => outward(p).dy === -1);
      const bot = pins.find((p) => outward(p).dy === 1);
      return top && bot ? { top, bot } : null;
    };
    const isCrystal = (ref: string): boolean => /crystal|reson/i.test(partByRef.get(ref)?.libId ?? '');
    /** A part the chain pass may move: two vertical leads, in this group, not
     * already spoken for by the decap row or the crystal template. */
    const chainable = (ref: string): boolean =>
      inGroup.has(ref) && !decapOwner.has(ref) && !idiomPlaced.has(ref) && !isCrystal(ref) && vertPins(ref) !== null;
    const parseEp = (ep: string): { ref: string; pin: string } | null => {
      const m = /^([^.]+)\.(.+)$/.exec(ep);
      return m ? { ref: m[1]!, pin: m[2]! } : null;
    };
    const classOf = (name: string): NetClass => netClasses.get(name)?.cls ?? 'signal';
    const padOverlap = (a: Bounds, b: Bounds, pad: number): boolean =>
      a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minY < b.maxY + pad && a.maxY > b.minY - pad;
    /** Candidate placement putting `ref`'s TOP pin connection point at (x, y). */
    const candidateAt = (ref: string, x: number, y: number): Placed => {
      const sym = symbols.get(ref)!;
      const v = vertPins(ref)!;
      const b = bodyBoundsOf(sym);
      const ox = x - v.top.x;
      const oy = y + v.top.y;
      const prev = placed.get(ref)!;
      return {
        part: prev.part,
        sym,
        x: ox,
        y: oy,
        body: { minX: ox + b.minX, minY: oy - b.maxY, maxX: ox + b.maxX, maxY: oy - b.minY },
        cellW: prev.cellW,
        cellH: prev.cellH,
      };
    };
    /** Apply candidate moves unless any moved body lands within a grid unit of
     * an unmoved one; all-or-nothing so a failed fit changes nothing. */
    const applyMoves = (moves: Map<string, Placed>): boolean => {
      for (const cand of moves.values()) {
        for (const [oref, op] of placed) {
          if (moves.has(oref)) continue;
          if (padOverlap(cand.body, op.body, U)) return false;
        }
      }
      for (const [ref, cand] of moves) placed.set(ref, cand);
      return true;
    };
    /** Every endpoint of every net a set of parts touches (the chain's own
     * connection points, allowed to sit on its axis by definition). */
    const ownEndpoints = (refs: Iterable<string>): Set<string> => {
      const eps = new Set<string>();
      for (const ref of refs) {
        for (const pin of symbols.get(ref)?.pins ?? []) {
          const net = netByEndpoint.get(`${ref}.${pin.number}`);
          for (const ep of net?.pins ?? []) eps.add(ep);
        }
      }
      return eps;
    };
    /**
     * A chain's wires run vertically along one x. No FOREIGN connected pin or
     * stub end may sit on that line within the chain's y-range: KiCad joins
     * wires at coincident endpoints, so a chain routed down a column of
     * neighbouring stub ends silently merges nets. The first npn-switch run
     * of this pass did exactly that — the reset pull-up's run down U1's
     * left-pin stub column attached 5V to DRIVE. Body boxes cannot catch
     * this; the check must be against connection points.
     */
    const axisClear = (
      axisX: number,
      yMin: number,
      yMax: number,
      ownEps: Set<string>,
      conn: { y: number; net: string }[] = [],
      movedRefs: Set<string> = new Set<string>(),
    ): boolean => {
      for (const [oref, opl] of placed) {
        for (const pin of opl.sym.pins) {
          const ep = `${oref}.${pin.number}`;
          const net = netByEndpoint.get(ep);
          if (!net) continue;
          const o = outward(pin);
          const len = classOf(net.name) !== 'signal' && o.dx !== 0 ? STUB + 2 : STUB;
          const p = pinAt(opl, pin);
          const end = { x: p.x + o.dx * len * U, y: p.y + o.dy * len * U };
          if (!ownEps.has(ep)) {
            for (const q of [p, end]) {
              if (sameCoord(q.x, axisX) && q.y > yMin - U && q.y < yMax + U) return false;
            }
          }
          // A horizontal stub SEGMENT crossing the axis exactly at a chain
          // CONNECTION row of a DIFFERENT net passes through that connection
          // point — a mid-segment crossing elsewhere is harmless, but a lead
          // parked on the crossing row is a KiCad join. The pull-up idiom
          // parked R1's bottom lead on U1's power-pin row and the VCC stub
          // ran straight through the pulled SIG node (I22's chain-pass face,
          // #204). Net-aware, because ownEps is too coarse here: U1's VCC pin
          // shares a net with the chain's rail end, yet its stub through a
          // SIG row still merges. Moved parts are skipped — `placed` holds
          // their stale pre-move positions.
          if (o.dx !== 0 && !movedRefs.has(oref)) {
            const row = conn.find((c) => sameCoord(c.y, p.y));
            if (row && row.net !== net.name) {
              const lo = Math.min(p.x, end.x) - 0.001;
              const hi = Math.max(p.x, end.x) + 0.001;
              if (axisX >= lo && axisX <= hi) return false;
            }
          }
        }
      }
      return true;
    };
    /** The room a rail/ground end grows past its pin: stub, bar, value text. */
    const POWER_CLEAR = 8 * U;
    const powerEndBox = (axisX: number, pinY: number, dir: -1 | 1): Bounds => ({
      minX: axisX - 3 * U,
      maxX: axisX + 3 * U,
      minY: dir === -1 ? pinY - POWER_CLEAR : pinY,
      maxY: dir === -1 ? pinY : pinY + POWER_CLEAR,
    });
    /** Clearance-check a chain (or flank) move set against its axis and its
     * power-end growth, then apply; marks the parts idiom-placed only when
     * everything held. */
    const finalizeMoves = (
      segments: { axisX: number; ys: number[]; conn?: { y: number; net: string }[] }[],
      moves: Map<string, Placed>,
      clearBoxes: Bounds[] = [],
    ): boolean => {
      const own = ownEndpoints(moves.keys());
      const movedRefs = new Set(moves.keys());
      for (const seg of segments) {
        // the pad covers the power stub and symbol a rail/ground end grows
        if (!axisClear(seg.axisX, Math.min(...seg.ys) - 4 * U, Math.max(...seg.ys) + 4 * U, own, seg.conn ?? [], movedRefs)) return false;
      }
      // a power symbol is not a body, so the body check cannot see it: the
      // divider repro grew R2's GND bar and value text straight into the body
      // of the part below until these boxes were checked explicitly
      for (const box of clearBoxes) {
        for (const [oref, op] of placed) {
          if (moves.has(oref)) continue;
          if (padOverlap(box, op.body, 0)) return false;
        }
      }
      if (!applyMoves(moves)) return false;
      for (const ref of moves.keys()) idiomPlaced.add(ref);
      return true;
    };

    // Crystal flanking: each horizontal crystal pin whose net also reaches a
    // two-lead cap-to-ground drops that cap below the pin's stub end. The
    // crystal's pins are symmetric about its body, so the two caps come out
    // mirror-placed at equal offsets and a common height by construction.
    for (const m of members) {
      if (!isCrystal(m.ref)) continue;
      const xpl = placed.get(m.ref);
      const xsym = symbols.get(m.ref);
      if (!xpl || !xsym || xsym.pins.length !== 2) continue;
      const moves = new Map<string, Placed>();
      const segments: { axisX: number; ys: number[] }[] = [];
      const clearBoxes: Bounds[] = [];
      for (const pin of xsym.pins) {
        const o = outward(pin);
        if (o.dx === 0) continue;
        const net = netByEndpoint.get(`${m.ref}.${pin.number}`);
        if (!net || classOf(net.name) !== 'signal') continue;
        const cap = net.pins
          .map(parseEp)
          .find((e): e is { ref: string; pin: string } => {
            if (!e || e.ref === m.ref || !chainable(e.ref) || moves.has(e.ref)) return false;
            const v = vertPins(e.ref)!;
            if (e.pin !== v.top.number) return false; // crystal node must enter the cap's top lead
            const other = netByEndpoint.get(`${e.ref}.${v.bot.number}`);
            return other !== undefined && classOf(other.name) !== 'signal';
          });
        if (!cap) continue;
        const at = pinAt(xpl, pin);
        const axisX = at.x + o.dx * STUB * U;
        const cand = candidateAt(cap.ref, axisX, at.y + CHAIN_GAP);
        const v = vertPins(cap.ref)!;
        moves.set(cap.ref, cand);
        segments.push({ axisX, ys: [at.y, cand.y - v.bot.y] });
        clearBoxes.push(powerEndBox(axisX, cand.y - v.bot.y, 1)); // the ground symbol below the cap
      }
      // all-or-nothing per crystal: one dropped cap and one column cap would
      // read worse than the plain columns the pass is improving on
      if (moves.size) finalizeMoves(segments, moves, clearBoxes);
    }

    // Drop chains: a maximal run of two-lead vertical parts linked pin-to-pin
    // by two-endpoint signal nets, ended on each side by an anchor pin (any
    // other part) or a power-class net. The run is restacked as one straight
    // vertical line: on the anchor's stub-end axis when there is an anchor
    // (the wire from the anchor continues dead straight into the chain), on
    // its own column axis when both ends are rails (a divider). Uniform gaps,
    // top-to-bottom in connectivity order — AC-16.31's zero-bend contract.
    type ChainEnd =
      | { kind: 'power' | 'open' | 'invalid' }
      | { kind: 'anchor'; ref: string; pin: DraftPin };
    const walk = (start: string, dir: 'up' | 'down', chain: string[]): ChainEnd => {
      let current = start;
      for (;;) {
        const v = vertPins(current)!;
        const pinN = dir === 'up' ? v.top.number : v.bot.number;
        const net = netByEndpoint.get(`${current}.${pinN}`);
        if (!net) return { kind: 'open' }; // declared no-connect or unused
        if (classOf(net.name) !== 'signal') return { kind: 'power' };
        if (net.pins.length !== 2) return { kind: 'invalid' }; // a tapped node is not a series chain
        const otherEp = net.pins.map(parseEp).find((e) => e !== null && e.ref !== current);
        if (!otherEp) return { kind: 'invalid' };
        const opl = placed.get(otherEp.ref);
        if (!opl || groupOf.get(otherEp.ref) !== gname) return { kind: 'invalid' };
        if (chainable(otherEp.ref) && !chain.includes(otherEp.ref)) {
          const ov = vertPins(otherEp.ref)!;
          // the link must enter through the lead facing the chain, or the
          // drawn run would have to cross the part's own body
          if (otherEp.pin !== (dir === 'up' ? ov.bot.number : ov.top.number)) return { kind: 'invalid' };
          if (dir === 'up') chain.unshift(otherEp.ref);
          else chain.push(otherEp.ref);
          current = otherEp.ref;
          continue;
        }
        const pin = symbols.get(otherEp.ref)?.pins.find((p) => p.number === otherEp.pin);
        if (!pin || chain.includes(otherEp.ref)) return { kind: 'invalid' };
        return { kind: 'anchor', ref: otherEp.ref, pin };
      }
    };
    const chained = new Set<string>();
    for (const m of members) {
      if (!chainable(m.ref) || chained.has(m.ref)) continue;
      const chain = [m.ref];
      const topEnd = walk(m.ref, 'up', chain);
      const bottomEnd = walk(chain[chain.length - 1]!, 'down', chain);
      for (const ref of chain) chained.add(ref);
      if (topEnd.kind === 'invalid' || bottomEnd.kind === 'invalid') continue;
      if (chain.length > 4) continue; // beyond four parts this is a network, not an idiom
      const anchors = [topEnd, bottomEnd].filter((e): e is Extract<ChainEnd, { kind: 'anchor' }> => e.kind === 'anchor');
      if (anchors.length === 0 && chain.length < 2) continue; // a lone floating part has nothing to align to
      if (topEnd.kind === 'open' && bottomEnd.kind === 'open') continue;

      const stubEndOf = (a: Extract<ChainEnd, { kind: 'anchor' }>): { x: number; y: number; o: { dx: number; dy: number } } => {
        const at = pinAt(placed.get(a.ref)!, a.pin);
        const o = outward(a.pin);
        return { x: at.x + o.dx * STUB * U, y: at.y + o.dy * STUB * U, o };
      };
      let axisX: number;
      let cursor: number; // y of the next TOP pin to place
      let order = chain;
      if (topEnd.kind === 'anchor') {
        const s = stubEndOf(topEnd);
        if (s.o.dy === -1) continue; // an up-facing pin cannot feed a downward run
        if (bottomEnd.kind === 'anchor') {
          const b = stubEndOf(bottomEnd);
          // both ends must sit on one axis with the second anchor below and
          // able to receive from above, else leave the columns alone
          if (!sameCoord(s.x, b.x) || b.y <= s.y || b.o.dy === 1) continue;
        }
        axisX = s.x;
        cursor = s.y + CHAIN_GAP;
      } else if (bottomEnd.kind === 'anchor') {
        // rail above, anchor below (a pull-up): stack upward from the anchor
        const s = stubEndOf(bottomEnd);
        if (s.o.dy === 1) continue; // a down-facing pin cannot feed an upward run
        axisX = s.x;
        order = [...chain].reverse();
        // Bounded lift: when a connection row would sit on a foreign stub's
        // crossing (axisClear's segment check), raise the whole stack a grid
        // row at a time rather than shipping the contact or losing the idiom.
        const netOf = (ref: string, pinN: string): string => netByEndpoint.get(`${ref}.${pinN}`)?.name ?? '';
        for (let lift = 0; lift < 3; lift++) {
          let up = s.y - CHAIN_GAP - lift * 2 * U;
          const moves = new Map<string, Placed>();
          const conn: { y: number; net: string }[] = [{ y: s.y, net: netOf(bottomEnd.ref, bottomEnd.pin.number) }];
          for (const ref of order) {
            const v = vertPins(ref)!;
            const span = v.top.y - v.bot.y; // symbol-space lead separation
            const cand = candidateAt(ref, axisX, up - span);
            moves.set(ref, cand);
            conn.push({ y: up, net: netOf(ref, v.bot.number) }, { y: up - span, net: netOf(ref, v.top.number) });
            up = up - span - CHAIN_GAP;
          }
          const topY = up + CHAIN_GAP;
          const topRef = order[order.length - 1]!;
          const done = finalizeMoves(
            [{ axisX, ys: [s.y, topY], conn: [...conn, { y: topY, net: netOf(topRef, vertPins(topRef)!.top.number) }] }],
            moves,
            topEnd.kind === 'power' ? [powerEndBox(axisX, topY, -1)] : [],
          );
          if (done) break;
        }
        continue;
      } else {
        // both ends are rails: a divider — straighten in place on its own axis
        const first = placed.get(chain[0]!)!;
        const v = vertPins(chain[0]!)!;
        const topAt = pinAt(first, v.top);
        axisX = topAt.x;
        cursor = topAt.y;
      }
      const cursor0 = cursor;
      const netOf2 = (ref: string, pinN: string): string => netByEndpoint.get(`${ref}.${pinN}`)?.name ?? '';
      for (let lift = 0; lift < 3; lift++) {
        cursor = cursor0 + lift * 2 * U;
        const moves = new Map<string, Placed>();
        const startY = cursor;
        const conn: { y: number; net: string }[] = [];
        let fits = true;
        for (const ref of order) {
          const cand = candidateAt(ref, axisX, cursor);
          moves.set(ref, cand);
          const v = vertPins(ref)!;
          conn.push({ y: cursor, net: netOf2(ref, v.top.number) }, { y: cursor + (v.top.y - v.bot.y), net: netOf2(ref, v.bot.number) });
          cursor = cursor + (v.top.y - v.bot.y) + CHAIN_GAP;
        }
        let axisEndY = cursor - CHAIN_GAP;
        if (bottomEnd.kind === 'anchor') {
          // cursor now sits one gap below the last lead; it may not pass the
          // lower anchor's stub end or the closing wire would run backwards
          const b = stubEndOf(bottomEnd);
          if (cursor > b.y + 0.001) fits = false;
          axisEndY = b.y;
        }
        const clearBoxes: Bounds[] = [];
        if (topEnd.kind === 'power') clearBoxes.push(powerEndBox(axisX, startY, -1));
        if (bottomEnd.kind === 'power') clearBoxes.push(powerEndBox(axisX, cursor - CHAIN_GAP, 1));
        const endNet = conn.length ? conn[0]!.net : '';
        const startConn = { y: cursor0 - CHAIN_GAP, net: topEnd.kind === 'anchor' ? netOf2(topEnd.ref, topEnd.pin.number) : endNet };
        const lastConn = { y: axisEndY, net: bottomEnd.kind === 'anchor' ? netOf2(bottomEnd.ref, bottomEnd.pin.number) : (conn.length ? conn[conn.length - 1]!.net : '') };
        if (fits && finalizeMoves([{ axisX, ys: [cursor0 - CHAIN_GAP, axisEndY], conn: [startConn, ...conn, lastConn] }], moves, clearBoxes)) break;
        if (!fits) break; // lifting only shrinks the room below; no retry can help
      }
    }

    const memberRefs = [...members.map((m) => m.ref), ...capRefs];
    const cells = memberRefs.map((r) => placed.get(r)!);
    if (cells.length) {
      const minX = Math.min(...cells.map((c) => c.body.minX)) - MARGIN * U;
      const maxX = Math.max(...cells.map((c) => c.body.maxX)) + MARGIN * U;
      const minY = Math.min(...cells.map((c) => c.body.minY)) - (MARGIN + 4) * U;
      const maxY = Math.max(...cells.map((c) => c.body.maxY)) + (MARGIN + 2) * U;
      groupRects.push({ name: gname, x1: minX, y1: minY, x2: maxX, y2: maxY });
      groupX = Math.round(maxX / U) + GROUP_GAP;
      prevGroup = gname;
    }
  }

  // ---------- shelf-wrap: reflow the group ribbon into rows (design D12) ----------
  // Groups tile left-to-right above, which on a design with many subsystems
  // yields a ribbon: this repo's light controller came out 750 x 83 mm, a 9:1
  // strip that forces A1 and leaves 85% of the sheet empty. Wrapping that into
  // rows is what a human drafter does, and it costs nothing in readability as
  // long as the reading order is preserved — groups keep their declared order
  // and fill left-to-right, then top-to-bottom, exactly like text.
  //
  // Runs BEFORE the wire/label pass so spans are measured on final coordinates:
  // a shorter sheet turns some label pairs back into real wires.
  const paperHint = intent.hints?.paper;
  if (paperHint && !PAPERS.some((p) => p.name === paperHint)) {
    notes.push(`paper hint "${paperHint}" is not a standard size; deriving paper from content`);
  }
  const hinted = paperHint ? PAPERS.find((p) => p.name === paperHint) : undefined;
  // A hint pins the width budget; otherwise try every sheet, smallest first.
  const candidates = hinted ? [hinted] : PAPERS;
  const gap = GROUP_GAP * U;

  // Nothing to reflow below two groups: one group is already its own row, and
  // an intent whose parts are all power symbols has no group rect to measure
  // from at all.
  if (groupRects.length > 1) {
    /**
     * Shelf-wrap the group rects to a width budget; returns per-group offsets.
     *
     * Offsets are relative to where the single-row pass already put each group,
     * never absolute targets: a row that does not wrap gets dx = dy = 0 and its
     * geometry is bit-for-bit what it was. Re-deriving absolute positions here
     * would re-round every group's width through the grid and shift
     * long-standing layouts by a unit for no reason.
     */
    const wrapTo = (budgetW: number): { deltas: { dx: number; dy: number }[]; w: number; h: number } => {
      const originX = groupRects[0]!.x1;
      const deltas: { dx: number; dy: number }[] = [];
      let rowOriginX = originX;
      let dyUnits = 0;
      let rowH = 0;
      for (const r of groupRects) {
        // A group wider than the whole budget still starts its own row; it will
        // overflow, and the caller rejects this paper for it.
        if (r.x1 > rowOriginX && r.x2 - rowOriginX > budgetW) {
          dyUnits += Math.ceil((rowH + gap) / U);
          rowOriginX = r.x1;
          rowH = 0;
        }
        deltas.push({ dx: grid(Math.round((originX - rowOriginX) / U)), dy: dyUnits * U });
        rowH = Math.max(rowH, r.y2 - r.y1);
      }
      const xs = groupRects.flatMap((r, i) => [r.x1 + deltas[i]!.dx, r.x2 + deltas[i]!.dx]);
      const ys = groupRects.flatMap((r, i) => [r.y1 + deltas[i]!.dy, r.y2 + deltas[i]!.dy]);
      return { deltas, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };

    let wrap = wrapTo(candidates[candidates.length - 1]!.w - 2 * FRAME);
    for (const p of candidates) {
      const w = wrapTo(p.w - 2 * FRAME);
      if (w.w <= p.w - 2 * FRAME && w.h <= p.h - 2 * FRAME - TITLE_STRIP) {
        wrap = w;
        break;
      }
    }
    const rows = new Set(wrap.deltas.map((d) => d.dy)).size;
    if (rows > 1) notes.push(`groups wrapped onto ${rows} rows to fit the sheet`);
    groupRects.forEach((r, i) => {
      const d = wrap.deltas[i]!;
      if (!d.dx && !d.dy) return;
      for (const ref of [...groupOf.entries()].filter(([, g]) => g === r.name).map(([ref]) => ref)) {
        const pl = placed.get(ref);
        if (!pl) continue;
        pl.x += d.dx;
        pl.y += d.dy;
        pl.body.minX += d.dx;
        pl.body.maxX += d.dx;
        pl.body.minY += d.dy;
        pl.body.maxY += d.dy;
      }
      r.x1 += d.dx;
      r.x2 += d.dx;
      r.y1 += d.dy;
      r.y2 += d.dy;
    });
  }

  // ---------- stubs, power symbols, labels, wires (design D2/D6a) ----------
  const wires: PlacementModel['wires'] = [];
  const labels: PlacementModel['labels'] = [];
  const junctions: { x: number; y: number }[] = [];
  const extraSymbols: EmitSymbol[] = [];
  const libSymbols = new Map<string, string>();
  const pwrFlags: string[] = [];
  /** Labels sitting at a stub end, with the stub they may ride outward. */
  const stubbedLabels: { label: number; wire: number; o: { dx: number; dy: number } }[] = [];
  /** Wired-net labels with every wire point of their run as fallback anchors. */
  const wiredLabels: { label: number; pts: { x: number; y: number }[] }[] = [];
  let wireIdx = new Map<string, number>();
  const addWire = (net: string, x1: number, y1: number, x2: number, y2: number): void => {
    if (sameCoord(x1, x2) && sameCoord(y1, y2)) return; // zero-length once emitted

    const i = wireIdx.get(net) ?? 0;
    wireIdx.set(net, i + 1);
    wires.push({ x1, y1, x2, y2, net, index: i });
  };

  let pwrSeq = 0;
  let flgSeq = 0;
  const endpointsOf = (net: IntentNet): { ref: string; pin: DraftPin; at: { x: number; y: number } }[] => {
    const eps = net.pins
      .map((ep) => {
        const m = /^([^.]+)\.(.+)$/.exec(ep)!;
        const pl = placed.get(m[1]!);
        const pin = symbols.get(m[1]!)?.pins.find((p) => p.number === m[2]);
        if (!pl || !pin) return null;
        return { ref: m[1]!, pin, at: pinAt(pl, pin) };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }) || a.pin.number.localeCompare(b.pin.number, undefined, { numeric: true }));
    // Stacked pins are one point on the sheet: KiCad symbols routinely repeat a
    // pin at the same coordinate (a thermal pad carried as a second GND pin, a
    // doubled supply pin). Drafting per PIN would stack a stub, a power symbol,
    // and its value text exactly on top of an identical one — invisible in the
    // render, an overlap to the checker, redundant to a reviewer. One item per
    // POINT; connectivity is unchanged because the pins share the point.
    return eps.filter((e, i) => eps.findIndex((o) => o.at.x === e.at.x && o.at.y === e.at.y) === i);
  };

  // power-class nets: per-pin power symbols, rails up, grounds down; one
  // PWR_FLAG per net without a power_out driver (design D6a). The stub runs in
  // the pin's OUTWARD direction — a fixed vertical drop would land on the next
  // pin of a connector-style part (2 grid rows apart) and short two nets.
  // Horizontal stubs run 4 units so their symbol clears the 2-unit signal
  // stubs and label anchors of neighbouring rows.
  const powerBodies = [...placed.values()].map((p) => p.body);
  /** Visible power value texts placed so far, for the collision rules below. */
  const shownPowerValues: { net: string; box: Bounds }[] = [];
  const powerValueBox = (net: string, x: number, y: number): Bounds => {
    const w = Math.max(1, net.length) * LABEL_ADVANCE * LABEL_HEIGHT;
    return { minX: x - w / 2, minY: y - LABEL_HEIGHT / 2, maxX: x + w / 2, maxY: y + LABEL_HEIGHT / 2 };
  };
  for (const net of [...powerNets].sort((a, b) => a.name.localeCompare(b.name))) {
    const cls = netClasses.get(net.name)!.cls;
    const src = powerSymbolSource(net.name, cls === 'ground' ? 'ground' : 'rail');
    libSymbols.set(src.libId, src.sourceText);
    const hasDriver = net.pins.some((ep) => pinLookup(ep)?.etype === 'power_out');
    const eps = endpointsOf(net);
    eps.forEach((ep, i) => {
      const o = outward(ep.pin);
      let len = o.dx !== 0 ? STUB + 2 : STUB;
      const at = (l: number): { x: number; y: number } => ({ x: ep.at.x + o.dx * l * U, y: ep.at.y + o.dy * l * U });
      const valueAtOf = (end: { x: number; y: number }): { x: number; y: number } => ({
        x: end.x,
        y: end.y + (o.dy !== 0 ? o.dy * 3.556 : cls === 'ground' ? 3.556 : -3.556),
      });
      // Adjacent power pins collide their value texts two ways, resolved two
      // ways. The SAME net repeated (a TQFP's VCC pins one row apart) hides
      // the duplicates: one visible name per cluster carries the same
      // information. A DIFFERENT net's name may never be hidden, so its
      // symbol rides its own stub outward, a bounded grid step at a time,
      // until the text clears — keeping "every gate failure is resolvable
      // through the IR" true for a collision the IR cannot otherwise reach.
      let hideValue = false;
      {
        const first = valueAtOf(at(len));
        const firstBox = powerValueBox(net.name, first.x, first.y);
        if (shownPowerValues.some((p) => p.net === net.name && boundsOverlap(p.box, firstBox))) {
          hideValue = true;
        } else {
          for (let extra = 0; extra < 4; extra++) {
            const v = valueAtOf(at(len));
            const b = powerValueBox(net.name, v.x, v.y);
            if (!shownPowerValues.some((p) => p.net !== net.name && boundsOverlap(p.box, b))) break;
            const extended = at(len + 2);
            if (powerBodies.some((bd) => segCrossesBody(ep.at.x, ep.at.y, extended.x, extended.y, bd))) break;
            len += 2;
          }
        }
      }
      const stubEnd = at(len);
      const valueAt = valueAtOf(stubEnd);
      if (!hideValue) shownPowerValues.push({ net: net.name, box: powerValueBox(net.name, valueAt.x, valueAt.y) });
      addWire(net.name, ep.at.x, ep.at.y, stubEnd.x, stubEnd.y);
      pwrSeq++;
      extraSymbols.push({
        ref: `#PWR${String(pwrSeq).padStart(2, '0')}`,
        libId: src.libId,
        value: net.name,
        footprint: '',
        at: { x: stubEnd.x, y: stubEnd.y, rot: 0 },
        refAt: { x: stubEnd.x, y: stubEnd.y },
        // The bar is drawn on a fixed side of its own pin (rails above, grounds
        // below), but a stub leaves its pin in whatever direction the pin
        // faces. Offsetting the value by class alone therefore throws the text
        // back across the stub and into the part whenever the two disagree —
        // a rail hanging off a downward pin puts "+5V" on the symbol above it.
        // The text follows the stub outward, so it always lands on the far
        // side of the symbol from the part it serves.
        valueAt,
        hideRef: true,
        // the net name IS the flag's meaning: an anonymous bar tells a
        // reviewer nothing, so the value stays visible like stock power
        // symbols (the checker verifies it collides with nothing)
        hideValue,
        pinNumbers: ['1'],
      });
      if (i === 0 && !hasDriver) {
        const flag = pwrFlagSource();
        libSymbols.set(flag.libId, flag.sourceText);
        flgSeq++;
        // the flag's pin sits exactly on the stub END so KiCad's connectivity
        // (which joins at wire endpoints) sees the power_out driver
        extraSymbols.push({
          ref: `#FLG${String(flgSeq).padStart(2, '0')}`,
          libId: flag.libId,
          value: 'PWR_FLAG',
          footprint: '',
          at: { x: stubEnd.x, y: stubEnd.y, rot: 0 },
          refAt: { x: stubEnd.x, y: stubEnd.y },
          valueAt: { x: stubEnd.x, y: stubEnd.y },
          hideRef: true,
          hideValue: true,
          pinNumbers: ['1'],
        });
        pwrFlags.push(net.name);
      }
    });
  }

  // signal nets: local nets wired, everything else labelled at a stub
  const bodies = [...placed.values()].map((p) => p.body);
  /**
   * True when any of `segs` touches a FOREIGN connection point: a pin, the
   * stub end any connected pin grows (predicted — stubs of nets sorted later
   * are not emitted yet), or an already-emitted wire of another net. KiCad
   * joins wires at coincident endpoints and at an endpoint on a wire's
   * interior, so any such contact merges nets (I22, #204). Used by the
   * trunk-and-branch veto AND the labelled-stub fallback — the cap-to-ground
   * drop placed a cap whose own 2-unit stub ended exactly on the neighbouring
   * power pin's stub interior, so stubs need the check as much as trunks.
   */
  const touchesForeign = (
    segs: { x1: number; y1: number; x2: number; y2: number }[],
    netName: string,
    ownEps: Set<string>,
  ): boolean => {
    for (const [oref, opl] of placed) {
      for (const pin of opl.sym.pins) {
        const ep = `${oref}.${pin.number}`;
        const onet = netByEndpoint.get(ep);
        if (!onet || onet.name === netName || ownEps.has(ep)) continue;
        const o = outward(pin);
        const len = (netClasses.get(onet.name)?.cls ?? 'signal') !== 'signal' && o.dx !== 0 ? STUB + 2 : STUB;
        const p = pinAt(opl, pin);
        const end = { x: p.x + o.dx * len * U, y: p.y + o.dy * len * U };
        if (segs.some((c) => pointOnSeg(p.x, p.y, c) || pointOnSeg(end.x, end.y, c))) return true;
      }
    }
    for (const w of wires) {
      if (w.net === netName) continue;
      if (
        segs.some(
          (c) =>
            pointOnSeg(w.x1, w.y1, c) ||
            pointOnSeg(w.x2, w.y2, c) ||
            pointOnSeg(c.x1, c.y1, w) ||
            pointOnSeg(c.x2, c.y2, w),
        )
      ) {
        return true;
      }
    }
    return false;
  };
  let wired = 0;
  let labelled = 0;
  for (const net of [...signalNets].sort((a, b) => a.name.localeCompare(b.name))) {
    const eps = endpointsOf(net);
    if (!eps.length) continue;
    const stubs = eps.map((ep) => {
      const o = outward(ep.pin);
      return { ep, end: { x: ep.at.x + o.dx * STUB * U, y: ep.at.y + o.dy * STUB * U }, o };
    });
    const groupsTouched = new Set(eps.map((e) => groupOf.get(e.ref)));
    const spanX = Math.max(...stubs.map((s) => s.end.x)) - Math.min(...stubs.map((s) => s.end.x));
    const spanY = Math.max(...stubs.map((s) => s.end.y)) - Math.min(...stubs.map((s) => s.end.y));
    let asWire = groupsTouched.size === 1 && eps.length <= MAX_WIRED_ENDPOINTS && Math.max(spanX, spanY) <= MAX_WIRE_SPAN;

    if (asWire) {
      // trunk-and-branch: a vertical trunk with horizontal branches. Several
      // deterministic trunk positions are tried in order (median stub x, right
      // of everything, left of everything); the first collision-free routing
      // wins, and if none exists the net falls back to labels — the engine may
      // never trip its own wire-through-symbol gate.
      const xs = stubs.map((s) => s.end.x).sort((a, b) => a - b);
      const ys = stubs.map((s) => s.end.y);
      const trunkCandidates = [
        grid(Math.round(xs[Math.floor(xs.length / 2)]! / U)),
        grid(Math.round(xs[xs.length - 1]! / U) + STUB),
        grid(Math.round(xs[0]! / U) - STUB),
      ];
      let routed = false;
      for (const trunkX of trunkCandidates) {
        const candidate: { x1: number; y1: number; x2: number; y2: number }[] = [];
        for (const s of stubs) {
          candidate.push({ x1: s.ep.at.x, y1: s.ep.at.y, x2: s.end.x, y2: s.end.y });
          if (!sameCoord(s.end.x, trunkX)) candidate.push({ x1: s.end.x, y1: s.end.y, x2: trunkX, y2: s.end.y });
        }
        // the trunk is split at every branch meet: coincident wire ENDPOINTS
        // are what both KiCad and the geometric netlister join on
        const meetYs = [...new Map(ys.map((y) => [knum(y), y])).values()].sort((a, b) => a - b);
        for (let i = 1; i < meetYs.length; i++) {
          candidate.push({ x1: trunkX, y1: meetYs[i - 1]!, x2: trunkX, y2: meetYs[i]! });
        }
        if (candidate.some((c) => bodies.some((b) => segCrossesBody(c.x1, c.y1, c.x2, c.y2, b)))) continue;
        // No candidate segment may touch a foreign connection point (I22,
        // #204): a trunk routed down a column of neighbouring stub ends
        // silently merges nets. Mirrors the chain pass's axisClear,
        // generalized to every candidate segment.
        if (touchesForeign(candidate, net.name, new Set(net.pins))) continue;
        for (const c of candidate) addWire(net.name, c.x1, c.y1, c.x2, c.y2);
        // one label names the wired net (topmost-leftmost wire point): the net
        // stays identifiable to PINOUT/drift and to a reviewer without a
        // label-per-pin, matching hand-drafting practice
        const pts = candidate.flatMap((c) => [
          { x: c.x1, y: c.y1 },
          { x: c.x2, y: c.y2 },
        ]);
        pts.sort((a, b) => a.y - b.y || a.x - b.x);
        labels.push({ name: net.name, x: pts[0]!.x, y: pts[0]!.y, rot: 0 });
        wiredLabels.push({ label: labels.length - 1, pts });
        wired++;
        if (eps.length > 2) {
          for (const s of stubs) {
            const meet = sameCoord(s.end.x, trunkX) ? s.end : { x: trunkX, y: s.end.y };
            if (meet.y > Math.min(...ys) && meet.y < Math.max(...ys)) junctions.push(meet);
          }
        }
        routed = true;
        break;
      }
      if (!routed) asWire = false;
    }
    if (!asWire) {
      for (const s of stubs) {
        // A stub is a wire too: its endpoint resting on a foreign net's wire
        // or connection point merges nets exactly like a trunk would (the
        // cap-to-ground drop's 2-unit stub ended on the neighbouring power
        // pin's stub interior — I22's third face). Grow the stub a grid unit
        // at a time until the endpoint is clear; the interior then CROSSES
        // the foreign wire mid-segment, which does not connect. If no length
        // clears, emit the plain stub and let the merged-net gate refuse
        // loudly rather than ship the contact.
        let end = s.end;
        const own = new Set(net.pins);
        for (let extra = 0; extra <= 2; extra++) {
          const cand = {
            x: s.ep.at.x + s.o.dx * (STUB + extra) * U,
            y: s.ep.at.y + s.o.dy * (STUB + extra) * U,
          };
          if (!touchesForeign([{ x1: s.ep.at.x, y1: s.ep.at.y, x2: cand.x, y2: cand.y }], net.name, own)) {
            end = cand;
            break;
          }
        }
        addWire(net.name, s.ep.at.x, s.ep.at.y, end.x, end.y);
        // labels are always horizontal (drafting standard): leftward pins read
        // outward to the left, everything else extends to the right
        labels.push({ name: net.name, x: end.x, y: end.y, rot: s.o.dx === -1 ? 180 : 0 });
        stubbedLabels.push({ label: labels.length - 1, wire: wires.length - 1, o: s.o });
        labelled++;
      }
    }
  }

  // ---------- member symbols with collision-free text slots ----------
  // Built BEFORE the label de-collision pass so the pass can treat every
  // visible ref/value text as an obstacle: the checker measures text-vs-text
  // collisions at error severity, so a box the checker will see must be a box
  // the avoider saw first.
  const emitSymbols: EmitSymbol[] = [];
  for (const [ref, pl] of [...placed.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const pinSides = new Set(pl.sym.pins.map((p) => {
      const o = outward(p);
      return o.dx === -1 ? 'left' : o.dx === 1 ? 'right' : o.dy === -1 ? 'top' : 'bottom';
    }));
    const cy = (pl.body.minY + pl.body.maxY) / 2;
    const cx = (pl.body.minX + pl.body.maxX) / 2;
    const textW = Math.max(ref.length, pl.part.value.length) * 0.8 * 1.27;
    let refAt: { x: number; y: number };
    let valueAt: { x: number; y: number };
    if (!pinSides.has('top')) {
      refAt = { x: cx, y: pl.body.minY - 2.54 };
      // value stacks above the ref when the bottom also carries pins, and sits
      // below the body otherwise
      valueAt = pinSides.has('bottom') ? { x: cx, y: pl.body.minY - 5.08 } : { x: cx, y: pl.body.maxY + 2.54 };
    } else if (
      pl.body.maxX - pl.body.minX >= textW + 2.54 &&
      pl.body.maxY - pl.body.minY >= 7.62
    ) {
      // pins on top AND a body big enough to hold its own name: a TQFP-class
      // part carries pins on all four sides, so every outside slot lands on
      // some pin's stub or label; the body interior is the one guaranteed-free
      // area, and it is where KiCad's own large symbols put their text
      refAt = { x: cx, y: cy - 1.27 };
      valueAt = { x: cx, y: cy + 1.27 };
    } else {
      refAt = { x: pl.body.maxX + textW / 2 + 1.27, y: cy - 1.27 };
      valueAt = { x: pl.body.maxX + textW / 2 + 1.27, y: cy + 1.27 };
    }
    emitSymbols.push({
      ref,
      libId: pl.sym.libId,
      value: pl.part.value,
      footprint: pl.part.footprint ?? '',
      at: { x: pl.x, y: pl.y, rot: 0 },
      refAt,
      valueAt,
      pinNumbers: pl.sym.pins.map((p) => p.number),
    });
    libSymbols.set(pl.sym.libId, pl.sym.sourceText);
  }

  /** Centered text box, matching the checker's `textBounds` metrics. */
  const centeredTextBox = (s: string, x: number, y: number): Bounds => {
    const w = Math.max(1, s.length) * LABEL_ADVANCE * LABEL_HEIGHT;
    return { minX: x - w / 2, minY: y - LABEL_HEIGHT / 2, maxX: x + w / 2, maxY: y + LABEL_HEIGHT / 2 };
  };
  /** Text-box-vs-segment overlap; hoisted so slot refinement below and the
   * label pass share one metric. */
  const segHitsBoxEarly = (w: { x1: number; y1: number; x2: number; y2: number }, b: Bounds): boolean =>
    Math.min(w.x1, w.x2) < b.maxX - 0.01 &&
    Math.max(w.x1, w.x2) > b.minX + 0.01 &&
    Math.min(w.y1, w.y2) < b.maxY - 0.01 &&
    Math.max(w.y1, w.y2) > b.minY + 0.01;

  // ---------- symbol-field slot refinement (I23, #210) ----------
  // The heuristic slots above consult nothing: attempt-07 ended ERC-clean
  // with 8 error-severity findings that were exactly these ref/value fields
  // sitting on wires and neighbouring bodies, with no IR lever to move them.
  // Re-slot each dirty pair down a deterministic ladder; the first slot whose
  // boxes clear every wire, every FOREIGN body, and all field text placed so
  // far wins. Where the heuristic is already clean the output is
  // byte-identical; where nothing clears, the heuristic stays so the checker
  // still reports the collision honestly.
  {
    const fieldBoxes: Bounds[] = extraSymbols
      .filter((s) => !s.hideValue)
      .map((s) => centeredTextBox(s.value, s.valueAt.x, s.valueAt.y));
    for (const sym of emitSymbols) {
      const pl = placed.get(sym.ref)!;
      const cx = (pl.body.minX + pl.body.maxX) / 2;
      const cy = (pl.body.minY + pl.body.maxY) / 2;
      const textW = Math.max(sym.ref.length, sym.value.length) * 0.8 * 1.27;
      const pairClear = (r: { x: number; y: number }, v: { x: number; y: number }): boolean => {
        for (const b of [centeredTextBox(sym.ref, r.x, r.y), centeredTextBox(sym.value, v.x, v.y)]) {
          if (wires.some((w) => segHitsBoxEarly(w, b))) return false;
          for (const [oref, op] of placed) {
            if (oref !== sym.ref && boundsOverlap(b, op.body)) return false;
          }
          if (fieldBoxes.some((t) => boundsOverlap(t, b))) return false;
        }
        return true;
      };
      if (!pairClear(sym.refAt, sym.valueAt)) {
        const ladder: [{ x: number; y: number }, { x: number; y: number }][] = [];
        for (const extra of [0, 2.54]) {
          ladder.push(
            [{ x: cx, y: pl.body.maxY + 2.54 + extra }, { x: cx, y: pl.body.maxY + 5.08 + extra }],
            [{ x: cx, y: pl.body.minY - 5.08 - extra }, { x: cx, y: pl.body.minY - 2.54 - extra }],
            [
              { x: pl.body.maxX + textW / 2 + 1.27 + extra, y: cy - 1.27 },
              { x: pl.body.maxX + textW / 2 + 1.27 + extra, y: cy + 1.27 },
            ],
            [
              { x: pl.body.minX - textW / 2 - 1.27 - extra, y: cy - 1.27 },
              { x: pl.body.minX - textW / 2 - 1.27 - extra, y: cy + 1.27 },
            ],
          );
        }
        for (const [r, v] of ladder) {
          if (pairClear(r, v)) {
            sym.refAt = r;
            sym.valueAt = v;
            break;
          }
        }
      }
      fieldBoxes.push(centeredTextBox(sym.ref, sym.refAt.x, sym.refAt.y), centeredTextBox(sym.value, sym.valueAt.x, sym.valueAt.y));
    }
  }

  /** Every visible ref/value text the checker will measure. */
  const textObstacles: Bounds[] = [
    ...emitSymbols.flatMap((s) => [centeredTextBox(s.ref, s.refAt.x, s.refAt.y), centeredTextBox(s.value, s.valueAt.x, s.valueAt.y)]),
    ...extraSymbols.filter((s) => !s.hideValue).map((s) => centeredTextBox(s.value, s.valueAt.x, s.valueAt.y)),
  ];

  // Nets are drafted in name order, so a net can only avoid what is already on
  // the sheet: "COMP" cannot see the trunk "COMP_Z" is about to run through the
  // very point its label occupies. This pass runs once the routing is complete
  // and walks each stub-anchored label outward a grid unit at a time until its
  // text box clears every foreign wire, body, and visible ref/value text. The
  // anchor rides the stub it extends, so the label stays attached and
  // connectivity never changes.
  const segHitsBox = (w: { x1: number; y1: number; x2: number; y2: number }, b: Bounds): boolean =>
    Math.min(w.x1, w.x2) < b.maxX - 0.01 &&
    Math.max(w.x1, w.x2) > b.minX + 0.01 &&
    Math.min(w.y1, w.y2) < b.maxY - 0.01 &&
    Math.max(w.y1, w.y2) > b.minY + 0.01;
  /** Is (x, y) on the (axis-aligned) segment, endpoints included? */
  const segContains = (w: { x1: number; y1: number; x2: number; y2: number }, x: number, y: number): boolean =>
    x >= Math.min(w.x1, w.x2) - 0.01 &&
    x <= Math.max(w.x1, w.x2) + 0.01 &&
    y >= Math.min(w.y1, w.y2) - 0.01 &&
    y <= Math.max(w.y1, w.y2) + 0.01 &&
    (Math.abs(w.x1 - w.x2) < 0.01 ? Math.abs(x - w.x1) <= 0.01 : Math.abs(y - w.y1) <= 0.01);

  // Wired-net labels first: the single label naming a wired run used to be
  // pinned at the topmost-leftmost wire point with no clearance check, and on
  // a drop chain that point is the anchor corner — the text immediately lies
  // across the chain's vertical run. The label may sit at ANY point of its own
  // net's wires, so walk the run's points and take the first whose text box
  // clears everything the checker will measure; wires the point itself lies on
  // are the label's own attachment and never count as collisions.
  for (const rec of wiredLabels) {
    const lb = labels[rec.label]!;
    const clearWired = (x: number, y: number): boolean => {
      const box = labelTextBox(lb.name, x, y, 0);
      if (bodies.some((b) => boundsOverlap(box, b))) return false;
      if (textObstacles.some((b) => boundsOverlap(box, b))) return false;
      if (wires.some((w) => !segContains(w, x, y) && segHitsBox(w, box))) return false;
      return !labels.some(
        (o, i) => i !== rec.label && o.name !== lb.name && boundsOverlap(box, labelTextBox(o.name, o.x, o.y, o.rot)),
      );
    };
    if (clearWired(lb.x, lb.y)) continue;
    const alt = rec.pts.find((p) => clearWired(p.x, p.y));
    if (alt) {
      lb.x = alt.x;
      lb.y = alt.y;
    }
  }

  for (const rec of stubbedLabels) {
    const lb = labels[rec.label]!;
    const stub = wires[rec.wire]!;
    const clearAt = (x: number, y: number): boolean => {
      const box = labelTextBox(lb.name, x, y, lb.rot);
      if (bodies.some((b) => boundsOverlap(box, b))) return false;
      if (textObstacles.some((b) => boundsOverlap(box, b))) return false;
      if (wires.some((w, i) => i !== rec.wire && segHitsBox(w, box))) return false;
      // Foreign labels are part of what a label must clear, not just bodies and
      // wires. Without this the pass declares a point clear that another net's
      // label already holds, both labels stay put, and `findMergedNets` then
      // refuses the draft for a collision the avoider was never looking for —
      // an engine state no IR can steer out of, because the IR does not choose
      // coordinates. Read live from `labels`, so already-nudged neighbours are
      // seen at their final positions and immovable wired-net labels (which
      // carry no stub to ride) are seen at all.
      return !labels.some(
        (o, i) =>
          i !== rec.label &&
          o.name !== lb.name &&
          boundsOverlap(box, labelTextBox(o.name, o.x, o.y, o.rot)),
      );
    };
    /**
     * Does another net's label sit on exactly this point? That is the fatal
     * case — KiCad fuses the two nets — as opposed to merely overlapping text.
     */
    const mergesAt = (x: number, y: number): boolean =>
      labels.some((o, i) => i !== rec.label && o.name !== lb.name && sameCoord(o.x, x) && sameCoord(o.y, y));
    const rideTo = (x: number, y: number): void => {
      stub.x2 = x;
      stub.y2 = y;
      lb.x = x;
      lb.y = y;
    };
    if (clearAt(lb.x, lb.y)) continue;
    /** Candidate points along the stub, nearest first. */
    const candidates: { x: number; y: number }[] = [];
    for (let extra = 1; extra <= MAX_LABEL_NUDGE; extra++) {
      const x = lb.x + rec.o.dx * extra * U;
      const y = lb.y + rec.o.dy * extra * U;
      // an extension that would run the stub through a symbol is no better
      // than the collision it fixes
      if (bodies.some((b) => segCrossesBody(stub.x1, stub.y1, x, y, b))) break;
      candidates.push({ x, y });
    }
    const clear = candidates.find((c) => clearAt(c.x, c.y));
    if (clear) {
      rideTo(clear.x, clear.y);
      continue;
    }
    // Nothing fully clear within the nudge budget. Overlapping text is a
    // legibility cost the sheet can carry and the report will name; a shared
    // point is a merged net and refuses the whole draft. So when the label is
    // currently ON another net's point, take the nearest candidate that at
    // least breaks the coincidence — trading a refusal for a flagged blemish.
    // A label that merely overlaps is left alone: moving it would buy nothing
    // and the emitted sheet must stay a function of the IR alone.
    if (!mergesAt(lb.x, lb.y)) continue;
    const unmerged = candidates.find((c) => !mergesAt(c.x, c.y));
    if (unmerged) rideTo(unmerged.x, unmerged.y);
  }

  // junctions: any point where three or more wire ends meet
  const endCount = new Map<string, { x: number; y: number; n: number }>();
  for (const w of wires) {
    for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]] as const) {
      const k = pointKey(x, y);
      const e = endCount.get(k) ?? { x, y, n: 0 };
      e.n++;
      endCount.set(k, e);
    }
  }
  for (const e of endCount.values()) if (e.n >= 3) junctions.push({ x: e.x, y: e.y });
  const uniqJunctions = [...new Map(junctions.map((j) => [pointKey(j.x, j.y), j])).values()];

  // no-connect markers (design D6a)
  const noConnects: { x: number; y: number }[] = [];
  for (const ep of intent.noConnect ?? []) {
    const m = /^([^.]+)\.(.+)$/.exec(ep);
    if (!m) continue;
    const pl = placed.get(m[1]!);
    const pin = symbols.get(m[1]!)?.pins.find((p) => p.number === m[2]);
    if (pl && pin) noConnects.push(pinAt(pl, pin));
  }

  // ---------- sheet: content-derived paper, balanced placement ----------
  const allX = [...groupRects.map((r) => r.x1), ...groupRects.map((r) => r.x2)];
  const allY = [...groupRects.map((r) => r.y1), ...groupRects.map((r) => r.y2)];
  const contentW = allX.length ? Math.max(...allX) - Math.min(...allX) : 0;
  const contentH = allY.length ? Math.max(...allY) - Math.min(...allY) : 0;
  // `hinted` and the note for an unknown hint are resolved by the shelf-wrap
  // above, which needed the width budget to reflow against.
  const paper =
    hinted ??
    PAPERS.find((p) => contentW <= p.w - 2 * FRAME && contentH <= p.h - 2 * FRAME - TITLE_STRIP) ??
    PAPERS[PAPERS.length - 1]!;

  // offset so content sits centered in the usable area (whitespace balance,
  // design D11), snapped to the grid so origins stay grid-true
  const minX = allX.length ? Math.min(...allX) : 0;
  const minY = allY.length ? Math.min(...allY) : 0;
  const availW = paper.w - 2 * FRAME;
  const availH = paper.h - 2 * FRAME - TITLE_STRIP;
  const dx = grid(Math.round((FRAME + Math.max(0, (availW - contentW) / 2) - minX) / U));
  const dy = grid(Math.round((FRAME + 4 * U + Math.max(0, (availH - contentH) / 2) - minY) / U));
  const shift = <T extends { x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }>(o: T): T => {
    if (o.x !== undefined) o.x += dx;
    if (o.y !== undefined) o.y += dy;
    if (o.x1 !== undefined) o.x1 += dx;
    if (o.y1 !== undefined) o.y1 += dy;
    if (o.x2 !== undefined) o.x2 += dx;
    if (o.y2 !== undefined) o.y2 += dy;
    return o;
  };
  for (const s of [...emitSymbols, ...extraSymbols]) {
    s.at.x += dx;
    s.at.y += dy;
    shift(s.refAt);
    shift(s.valueAt);
  }
  wires.forEach(shift);
  labels.forEach(shift);
  uniqJunctions.forEach(shift);
  noConnects.forEach(shift);
  groupRects.forEach(shift);

  // Two labels of DIFFERENT nets at one point is a merged net, not a cosmetic
  // overlap: KiCad resolves co-located labels to a single net and reports
  // `Both A and B are attached to the same items; A will be used in the
  // netlist` — as a warning. A live run drew ISET (charge-current program) and
  // NTC (thermistor input) onto the same node of a BQ24040 that way, which
  // would have shipped a board whose charge current is not set by its
  // programming resistor and whose temperature cutoff does not work.
  //
  // The engine computes every coordinate, so this is ours to catch, and it is
  // strictly worse than the failures we do gate: an unreadable sheet stops the
  // pipeline loudly, while a merged net passes ERC-as-warning and flows into
  // layout and fabrication outputs. Reported as a hard finding — the netlist
  // the IR declared is not the netlist that got drawn.
  const mergedNets = [
    ...findMergedNets(labels).map((m) => ({ ...m, via: 'labels' as const })),
    ...findWireContactMerges(wires, labels).map((m) => ({ ...m, via: 'wires' as const })),
  ];

  // Overlapping label TEXT is the other half of the same pass and deliberately
  // not a gate. The de-collision loop clears what it can and, where it cannot,
  // prefers a legible-but-overlapping position over a merged net. What survives
  // is counted against a budget and named in the report, so a sheet never ships
  // a blemish silently and never stalls a run over one either.
  const labelOverlaps = findLabelOverlaps(labels);
  const labelOverlapBudgetExceeded =
    labels.length > 0 && labelOverlaps.length / labels.length > LABEL_OVERLAP_BUDGET;
  if (labelOverlaps.length) {
    const pct = ((labelOverlaps.length / Math.max(1, labels.length)) * 100).toFixed(1);
    const where = labelOverlaps
      .slice(0, 8)
      .map((o) => `${o.nets.join('/')} at (${o.x}, ${o.y})`)
      .join('; ');
    notes.push(
      `${labelOverlapBudgetExceeded ? 'LABEL OVERLAP BUDGET EXCEEDED: ' : ''}` +
        `${labelOverlaps.length} of ${labels.length} label(s) (${pct}%, budget ` +
        `${(LABEL_OVERLAP_BUDGET * 100).toFixed(1)}%) overlap a foreign net's label text. ` +
        `The netlist is unaffected — these are legibility defects, listed so they can be ` +
        `fixed or accepted deliberately: ${where}` +
        `${labelOverlaps.length > 8 ? `; and ${labelOverlaps.length - 8} more` : ''}`,
    );
  }

  const model: PlacementModel = {
    projectName,
    paper: paper.name,
    title: { title: projectName, date: today, rev: 'A' },
    libSymbols: [...libSymbols.entries()].map(([libId, sourceText]) => ({ libId, sourceText })),
    symbols: [...emitSymbols, ...extraSymbols],
    wires,
    junctions: uniqJunctions,
    labels,
    noConnects,
    rectangles: groupRects.map((r) => ({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, stroke: 'solid' as const, name: r.name })),
    captions: groupRects.map((r) => ({ text: r.name, x: r.x1 + 2, y: r.y1 + 2, name: r.name })),
  };

  const report: SchematicDraftReport = {
    groups: groupNames.map((g) => ({
      name: g,
      members: [...groupOf.entries()].filter(([, gg]) => gg === g).map(([r]) => r).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    })),
    netClasses: [...netClasses.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, c]) => ({ name, class: c.cls, overridden: c.overridden })),
    wireCount: wires.length,
    labelCount: labels.length,
    pwrFlags,
    noConnects: noConnects.length,
    paper: paper.name,
    notes,
    mergedNets,
    labelOverlaps,
    labelOverlapBudgetExceeded,
  };
  return { model, report };
}

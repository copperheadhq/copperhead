import type { Bounds } from '../sexp.js';
import { knum, CAPTION_SIZE, type PlacementModel, type EmitSymbol, type EmitLabel, type LabelShape } from '../emit.js';
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
/** Cell margin around a symbol body (room for stubs, labels, text), in units,
 * for the first draft; a measured round shrinks it to `MEASURED_MARGIN`. */
const BASE_MARGIN = 4;
/** Cell margin once the cell is sized from what it actually drew. */
const MEASURED_MARGIN = 2;
/** Vertical cell margin, units: rows are tighter than columns because a
 * part's texts sit beside it, not above and below; a pin that faces up or
 * down with a rail or ground on it reserves `POWER_REACH` instead. */
const VMARGIN = 2;
const POWER_REACH = 6;
/** Clear grid units kept beyond a cell's measured drawn extent. */
const MEASURE_PAD = 1;
/** What a cell drew beyond its body, mm on each side, measured on a finished draft. */
type Overhang = { left: number; right: number; top: number; bottom: number };
/** Padding, grid units, a group box keeps around the label and field text it
 * encloses, and the clearance kept between two such boxes. */
const BOX_PAD = 1;
const BOX_GAP = 4;
/** Vertical gap between rows and horizontal channel between columns, units. */
const ROW_GAP = 3;
const CHANNEL = 4;
/** Gap between group boxes, units. */
const GROUP_GAP = 4;
/** Local nets up to this many endpoints may be wired (design D2). */
const MAX_WIRED_ENDPOINTS = 4;
/** Wire-span budget in mm beyond which a net becomes labels. */
const MAX_WIRE_SPAN = 50.8;
/** Label text metrics, matching the legibility checker's conservative box. */
const LABEL_HEIGHT = 1.27;
/**
 * Advance the ENGINE gives text when it spaces groups, clears labels and
 * fields of one another, and draws the box around a group. The checker's 0.6
 * is tuned below KiCad's stroke font on purpose (design C3: never a false
 * collision); measured on a plotted sheet the font advances about 0.72 of
 * its height, so an engine that cleared text at 0.6 drew sheets where a rail
 * name ran into the label on the next pin row while the checker called them
 * clean. The engine is the side that must be conservative: it reserves 0.8.
 */
const LABEL_ADVANCE = 0.8;
const TEXT_RESERVE = LABEL_ADVANCE;
/** Advance of KiCad's stroke font for the upper-case pin names inside a
 * body, per height: wider than the mixed-case reserve above. */
const NAME_ADVANCE = 1.0;
/** Air between any two texts, mm. Boxes that merely do not overlap still
 * read as one smudge on paper (esp32-amp's "100k" sat 0.6 mm above
 * "USB_OV"); every clearance check pads the candidate by this. */
const TEXT_PAD = 0.8;
const padBox = (b: Bounds, p = TEXT_PAD): Bounds => ({ minX: b.minX - p, minY: b.minY - p, maxX: b.maxX + p, maxY: b.maxY + p });
/** `COPPERHEAD_DRAFT_TRACE=1` prints every placement decision the engine
 * makes silently: what it claimed, what it skipped and why, what it refused. */
const trace = (msg: string): void => {
  if (process.env['COPPERHEAD_DRAFT_TRACE']) console.error(`[draft] ${msg}`);
};
/** `labelTextBox` at the reserve advance: what the text takes on paper. */
const labelReserveBox = (name: string, x: number, y: number, rot: number, kind: EmitLabel['kind'] = 'local'): Bounds =>
  labelBoxAt(name, x, y, rot, kind, TEXT_RESERVE);
/**
 * Along-axis length a global label's flag adds beyond its text: the margin
 * either side of the text plus the pointed tip. Measured from eeschema's own
 * outline at 1.27 mm (a 12-character name draws 17.0 mm long against about
 * 14.5 of text), and kept a little generous because the advance estimate
 * under-reads wide glyphs.
 */
const FLAG_PAD = 2.5 * LABEL_HEIGHT;
/** Grid units of the caption band at the top of a group box: the bold
 * caption at `CAPTION_SIZE` plus clearance over the tallest thing a cell can
 * carry above its body (a rail symbol on an upward stub with its value text). */
const CAPTION_BAND = 7;
/**
 * The box a label occupies at `advance` per character. A local label is bare
 * text standing on its anchor (see `labelTextBox`); a global label is a flag
 * two text heights tall, centred on the anchor line, whose length runs away
 * from the anchor in the rotation's direction — 0 right, 90 up, 180 left,
 * 270 down in schematic Y-down coordinates, exactly as eeschema draws it.
 */
const labelBoxAt = (name: string, x: number, y: number, rot: number, kind: EmitLabel['kind'], advance: number): Bounds => {
  const textW = Math.max(1, name.length) * advance * LABEL_HEIGHT;
  if (kind === 'global') {
    const w = textW + FLAG_PAD;
    const h = LABEL_HEIGHT;
    const r = ((rot % 360) + 360) % 360;
    if (r === 90) return { minX: x - h, minY: y - w, maxX: x + h, maxY: y };
    if (r === 270) return { minX: x - h, minY: y, maxX: x + h, maxY: y + w };
    if (r === 180) return { minX: x - w, minY: y - h, maxX: x, maxY: y + h };
    return { minX: x, minY: y - h, maxX: x + w, maxY: y + h };
  }
  // A plain label STANDS on its anchor line: the checker measures it that way
  // (`labelBounds`), and so does the engine. The union box that also reached
  // half a height below the line dated from the checker's centred days; kept,
  // it made every name on a row collide with that row's own continuing wire
  // (esp32-amp's UART_TXD could stand nowhere on its 9 mm run).
  return rot === 180
    ? { minX: x - textW, minY: y - LABEL_HEIGHT, maxX: x, maxY: y }
    : { minX: x, minY: y - LABEL_HEIGHT, maxX: x + textW, maxY: y };
};
/** KiCad's label rotation for text running outward along a stub direction. */
const rotOutward = (o: { dx: number; dy: number }): number => (o.dx === -1 ? 180 : o.dy === -1 ? 90 : o.dy === 1 ? 270 : 0);
/**
 * Flag shape for a global label at a pin, from the pin's electrical type:
 * an output pin's net leaves through an output flag, an input's arrives
 * through an input flag, a bidirectional or tri-state pin's points both
 * ways, and everything else (passive parts, power, unspecified) gets the
 * plain box. Cosmetic to KiCad's ERC, informative to a reader.
 */
export function flagShape(etype: string): LabelShape {
  switch (etype) {
    case 'output':
    case 'open_collector':
    case 'open_emitter':
    case 'power_out':
      return 'output';
    case 'input':
      return 'input';
    case 'bidirectional':
    case 'tri_state':
      return 'bidirectional';
    default:
      return 'passive';
  }
}
/** How far a colliding label may ride its stub outward, in grid units.
 * Deep enough to carry a bottom-pin label past the routing channel that runs
 * under its connector (#220 phase 2); rungs stay ordered nearest-first, so a
 * label that used to clear at rung n still clears at rung n. */
const MAX_LABEL_NUDGE = 8;
/**
 * How far a power stub may be pulled in or pushed out to clear a foreign
 * connection point, in grid units. Bounded so the symbol stays visibly attached
 * to the pin it serves; past this the merged-net gate is the better answer.
 */
const MAX_POWER_STUB_SHIFT = 4;
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
/** Max pin-to-pin gap, grid units, for chaining a passive bank on one trunk
 * (#233): wide enough for two-pin parts sitting in adjacent COLUMNS (cell
 * width plus the channel, ~23 units), tight enough that a trunk never spans
 * unrelated structure — and every join is still vetoed by the body-crossing
 * and touches-foreign checks regardless of distance. */
const BANK_PITCH_MAX = 32;
/** Natural-fit utilization below which the paper pass tries smaller sheets
 * with width and height budgets (#220 phase 4). Matches the legibility
 * checker's low-utilization threshold: a sheet the checker would call mostly
 * empty is a sheet worth compacting. */
const COMPACT_UTILIZATION = 0.5;

export type NetClass = 'rail' | 'ground' | 'signal';
/**
 * What decided a net's class: an IR `kind` declaration, the library electrical
 * type of a pin it touches, or the last-resort supply-name shape. Reported per
 * net so a name-inferred class — the one inference no pin actually attests —
 * is visible and correctable through the IR.
 */
export type NetClassBasis = 'declared' | 'pin-type' | 'name';

export interface SchematicDraftReport {
  groups: { name: string; members: string[] }[];
  netClasses: { name: string; class: NetClass; overridden: boolean; basis: NetClassBasis }[];
  wireCount: number;
  labelCount: number;
  pwrFlags: string[];
  noConnects: number;
  paper: string;
  /**
   * The paper pass's verdict, for callers that gate on it rather than parse
   * the notes: which sheet, how much of it the placed cells ink, and whether
   * compaction ran, succeeded, or failed (with each smaller sheet's closest
   * miss when it did). `pinned` is a paper hint; `overflow` means nothing
   * holds the content and the frame will be crossed; `banded` means no sheet
   * held the natural ribbon and columns were wrapped to fit the smallest one.
   */
  sheetFit: {
    paper: string;
    inkUtilization: number;
    compaction: 'not-needed' | 'compacted' | 'banded' | 'failed' | 'pinned' | 'overflow';
    misses: string[];
    /** The squeeze: cells re-sized from what they drew, round by round. */
    squeeze?: { rounds: number; boxAreaBefore: number; boxAreaAfter: number };
  };
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

/** An orthogonal segment in schematic space, millimetres. */
export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Every on-grid point strictly BETWEEN the ends of each segment.
 *
 * Takes segments, never a bag of points: a label anchored at a point that lies
 * on no wire of its own net is attached to nothing in KiCad, and the net
 * silently loses the name the IR gave it. Callers that keep their points in
 * some other order (anchor preference, say) must pass the segments themselves
 * so the walk cannot interpolate between two points that share no wire.
 */
export function interiorGridPoints(segs: Seg[], step: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const seg of segs) {
    const steps = Math.round((Math.abs(seg.x2 - seg.x1) + Math.abs(seg.y2 - seg.y1)) / step);
    const sx = Math.sign(seg.x2 - seg.x1);
    const sy = Math.sign(seg.y2 - seg.y1);
    for (let k = 1; k < steps; k++) out.push({ x: seg.x1 + sx * k * step, y: seg.y1 + sy * k * step });
  }
  return out;
}

/**
 * Whether `seg` crosses the LINE a foreign pin's stub could grow along.
 *
 * `touchesForeign` predicts foreign stubs at their base length only, but a
 * signal stub's clearance ladder may extend it further — jetson-agx-thor-
 * baseboard shipped twelve trunk-on-stub contacts exactly that way, each a
 * merged net the gate then refused. `reach` is that maximum growth, in mm.
 * Both are orthogonal, so bounding-box overlap IS intersection, and it also
 * catches collinear overlap, conservatively.
 */
export function segCrossesStubGrowth(
  seg: Seg,
  pin: { x: number; y: number },
  o: { dx: number; dy: number },
  reach: number,
  eps: number,
): boolean {
  const ex = pin.x + o.dx * reach;
  const ey = pin.y + o.dy * reach;
  return (
    Math.min(seg.x1, seg.x2) <= Math.max(pin.x, ex) + eps &&
    Math.max(seg.x1, seg.x2) >= Math.min(pin.x, ex) - eps &&
    Math.min(seg.y1, seg.y2) <= Math.max(pin.y, ey) + eps &&
    Math.max(seg.y1, seg.y2) >= Math.min(pin.y, ey) - eps
  );
}

/**
 * Split one line of bank candidates into the runs that may share a trunk.
 *
 * `canStub` vets a member on its own (its stub must clear foreign points) and
 * `canJoin` vets the join to the member before it. A member that fails either
 * ends the run in progress — a bank never buys density with a merged net — and
 * a run of one is no bank at all, so only runs of two or more come back.
 * Pure, so the veto semantics are testable without a sheet to place.
 */
export function splitBankRuns<T>(line: T[], canStub: (c: T) => boolean, canJoin: (prev: T, c: T) => boolean): T[][] {
  const runs: T[][] = [];
  let run: T[] = [];
  const flush = (): void => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  for (const c of line) {
    if (!canStub(c)) {
      flush();
      continue;
    }
    if (!run.length) {
      run.push(c);
      continue;
    }
    if (canJoin(run[run.length - 1]!, c)) run.push(c);
    else {
      flush();
      run = [c];
    }
  }
  flush();
  return runs;
}

interface Placed {
  part: IntentPart;
  /** The drawn refdes (the part's ref, shared by every unit instance). */
  refDes: string;
  /** KiCad unit number for a multi-unit instance; null for single-unit parts. */
  unit: number | null;
  sym: ResolvedSymbol;
  /** Origin, mm (grid multiple). */
  x: number;
  y: number;
  body: Bounds; // schematic space, absolute
  cellW: number; // units
  cellH: number; // units
  /** Placement rotation, degrees CCW in symbol space (KiCad's `(at x y rot)`); `sym` is already rotated. */
  rot: number;
  /** KiCad `(mirror y)`: the symbol flipped left-for-right before rotation (a
   * transistor whose base must face the pin that drives it); `sym` is already mirrored. */
  mirror?: 'y';
}

/** `sym` mirrored left-for-right (KiCad's `(mirror y)`), then turned by `rot`. */
const transformSym = (sym: ResolvedSymbol, rot: number, mirror?: 'y'): ResolvedSymbol => {
  if (!mirror) return rotatedSym(sym, rot);
  const pins = sym.pins.map((p) => ({ ...p, x: -p.x, angle: (((180 - p.angle) % 360) + 360) % 360 }));
  const b = sym.body ? bodyBoundsOf(sym) : null;
  const body = b ? { minX: -b.maxX, maxX: -b.minX, minY: b.minY, maxY: b.maxY } : null;
  return rotatedSym({ ...sym, pins, body }, rot);
};

/**
 * The symbol as KiCad draws it at rotation `rot` (0, 90, 180, 270): pins,
 * their direction angles and the body box all turned in symbol space, so
 * every downstream helper (pinAt, outward, bodyBoundsOf) reads the drawn
 * geometry without knowing the part was turned. Matches `pinAbsolute`:
 * rx = x cos − y sin, ry = x sin + y cos.
 */
const rotatedSym = (sym: ResolvedSymbol, rot: number): ResolvedSymbol => {
  const r = ((rot % 360) + 360) % 360;
  if (r === 0) return sym;
  const turn = (x: number, y: number): { x: number; y: number } =>
    r === 90 ? { x: -y, y: x } : r === 180 ? { x: -x, y: -y } : { x: y, y: -x };
  const pins = sym.pins.map((p) => ({ ...p, ...turn(p.x, p.y), angle: (p.angle + r) % 360 }));
  const b = sym.body ? bodyBoundsOf(sym) : null;
  let body: Bounds | null = null;
  if (b) {
    const c1 = turn(b.minX, b.minY);
    const c2 = turn(b.maxX, b.maxY);
    body = { minX: Math.min(c1.x, c2.x), maxX: Math.max(c1.x, c2.x), minY: Math.min(c1.y, c2.y), maxY: Math.max(c1.y, c2.y) };
  }
  return { ...sym, pins, body };
};

/**
 * One placeable thing. A single-unit part is one instance whose key IS its
 * refdes. A multi-unit part (an opamp, a gate pack) becomes one instance per
 * unit, keyed `REF#unit`, each carrying only that unit's pins and body — the
 * units share symbol-space pin coordinates, so placing the symbol once would
 * overlay unrelated pins on one point and silently merge their nets (#218).
 * Net endpoints stay `REF.PIN` strings; pin numbers are package-unique, so
 * each endpoint resolves to exactly one instance.
 */
interface Instance {
  key: string;
  ref: string;
  unit: number | null;
  part: IntentPart;
  sym: ResolvedSymbol;
}

const bodyBoundsOf = (sym: ResolvedSymbol): Bounds => {
  if (sym.body) return sym.body;
  const xs = sym.pins.map((p) => p.x);
  const ys = sym.pins.map((p) => p.y);
  if (!xs.length) return { minX: -U, minY: -U, maxX: U, maxY: U };
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

/**
 * Wire and label colours by function: rails one colour, grounds another,
 * and every FAMILY of signal nets — the nets sharing a prefix before the
 * first underscore, when there are at least two of them (I2S_BCLK, I2S_DIN,
 * I2S_LRCLK; SPI_…; BTN_…) — a colour of its own from a fixed palette, in
 * family-name order so the same design colours the same way every time. A
 * lone signal keeps the theme's default: colouring everything in a block
 * one colour would say nothing.
 */
const FAMILY_PALETTE: [number, number, number][] = [
  [30, 90, 200],
  [130, 50, 170],
  [0, 130, 120],
  [210, 120, 0],
  [180, 30, 140],
  [110, 130, 0],
  [140, 80, 40],
  [40, 60, 140],
];
const RAIL_COLOR: [number, number, number] = [170, 30, 30];
const GROUND_COLOR: [number, number, number] = [70, 70, 70];
function netColorsOf(nets: IntentNet[], classes: Map<string, { cls: NetClass }>): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  const families = new Map<string, string[]>();
  for (const n of nets) {
    const cls = classes.get(n.name)?.cls ?? 'signal';
    if (cls === 'rail') out[n.name] = RAIL_COLOR;
    else if (cls === 'ground') out[n.name] = GROUND_COLOR;
    else {
      const m = /^([A-Za-z0-9]+)_/.exec(n.name);
      if (m) families.set(m[1]!, [...(families.get(m[1]!) ?? []), n.name]);
    }
  }
  const named = [...families.entries()].filter(([, members]) => members.length >= 2).sort((a, b) => a[0].localeCompare(b[0]));
  named.forEach(([, members], i) => {
    for (const name of members) out[name] = FAMILY_PALETTE[i % FAMILY_PALETTE.length]!;
  });
  return out;
}

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

/**
 * Supply-name shapes for the last-resort classification below. Deliberately
 * narrow, and narrow in ONE direction: a rail misread as a signal draws labels
 * (exactly what the engine did before the fallback existed), while a signal
 * misread as a rail draws a power symbol and makes the sheet assert a supply
 * the design does not have. So an underscore may join a VOLTAGE suffix
 * (VDD_3V3, VCC_1V8) and nothing else — VBUS_DET, VCC_SENSE and VDD_MON are
 * measurement nodes on real boards and stay signals. Anything the shapes miss
 * is still correctable with an IR `kind` declaration, which outranks all of
 * this, and the report names the basis so a miss is visible.
 */
const GROUND_NAME = /^([adp]?gnd[0-9a-z]*|vss[0-9a-z]*)$/i;
const RAIL_NAME = /^(?:[+-]?[0-9]+(?:\.[0-9]+)?v[0-9]*|(?:vcc|vdd|vbus|vee)[0-9a-z]*(?:_[0-9]+v[0-9]*)?)$/i;

function classifyNet(
  net: IntentNet,
  pinsOf: (ep: string) => DraftPin | null,
): { cls: NetClass; overridden: boolean; basis: NetClassBasis } {
  if (net.kind === 'power') return { cls: 'rail', overridden: true, basis: 'declared' };
  if (net.kind === 'ground') return { cls: 'ground', overridden: true, basis: 'declared' };
  if (net.kind === 'signal') return { cls: 'signal', overridden: true, basis: 'declared' };
  const touchesPower = net.pins.some((ep) => {
    const p = pinsOf(ep);
    return p !== null && (p.etype === 'power_in' || p.etype === 'power_out');
  });
  if (!touchesPower) {
    // No electrical-type evidence: real boards routinely carry their supplies
    // on embedded symbols whose pins are all `passive` (stickhub's GND, 80
    // pins, drafted as 80 labels and zero ground bars). Fall back to the
    // unambiguous supply-name shapes only; anything else stays signal.
    if (GROUND_NAME.test(net.name)) return { cls: 'ground', overridden: false, basis: 'name' };
    if (RAIL_NAME.test(net.name)) return { cls: 'rail', overridden: false, basis: 'name' };
    return { cls: 'signal', overridden: false, basis: 'name' };
  }
  return { cls: /gnd|vss/i.test(net.name) ? 'ground' : 'rail', overridden: false, basis: 'pin-type' };
}

const boundsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.minX < b.maxX - 0.01 && a.maxX > b.minX + 0.01 && a.minY < b.maxY - 0.01 && a.maxY > b.minY + 0.01;

/**
 * The box a label's text occupies, matching the legibility checker's
 * conservative metrics. Shared by the de-collision pass and the overlap report
 * so "clear" means one thing in the engine.
 */
const labelTextBox = (name: string, x: number, y: number, rot: number, kind: EmitLabel['kind'] = 'local'): Bounds =>
  // A local label is bottom-justified on its anchor: on paper the text stands
  // on the wire line and rises one full height above it, and the checker's
  // `labelBounds` measures exactly that. A global label's flag is measured as
  // eeschema draws it (`labelBoxAt`).
  labelBoxAt(name, x, y, rot, kind, LABEL_ADVANCE);

/**
 * Where a wired run's name may sit when it must be a global flag, in
 * preference order: standing up from the top of a vertical trunk (the flag on
 * a pole a reviewer expects), then every other wire end continuing its
 * segment outward, then the interior grid points of each segment with the
 * flag perpendicular to the wire, upward before downward. Every candidate
 * lies on a wire of the run, so the name always attaches.
 */
export function wiredFlagCandidates(segs: Seg[]): { x: number; y: number; rot: number }[] {
  const out: { x: number; y: number; rot: number }[] = [];
  const seen = new Set<string>();
  const push = (x: number, y: number, rot: number): void => {
    const k = `${pointKey(x, y)}/${rot}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ x, y, rot });
  };
  const vertical = segs.filter((s) => sameCoord(s.x1, s.x2));
  const horizontal = segs.filter((s) => !sameCoord(s.x1, s.x2));
  // Horizontal first: a name reads along the row it names (the drafting
  // standard keeps text horizontal), so the ends of horizontal segments
  // continuing outward come before a flag standing up from a trunk top, and
  // both before a flag perpendicular to a wire's interior.
  const ends = segs.flatMap((s) => [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const p of ends) {
    for (const s of horizontal) {
      if (!sameCoord(s.y1, p.y)) continue;
      if (sameCoord(p.x, Math.max(s.x1, s.x2))) push(p.x, p.y, 0);
      if (sameCoord(p.x, Math.min(s.x1, s.x2))) push(p.x, p.y, 180);
    }
  }
  const tops = vertical.map((s) => ({ x: s.x1, y: Math.min(s.y1, s.y2) })).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const t of tops) push(t.x, t.y, 90);
  for (const p of ends) {
    for (const s of vertical) {
      if (sameCoord(s.x1, p.x) && sameCoord(p.y, Math.max(s.y1, s.y2))) push(p.x, p.y, 270);
    }
  }
  for (const s of segs) {
    for (const rot of sameCoord(s.x1, s.x2) ? [0, 180] : [90, 270]) {
      for (const p of interiorGridPoints([s], U)) push(p.x, p.y, rot);
    }
  }
  return out;
}

/**
 * Pairs of labels naming DIFFERENT nets whose text boxes overlap.
 *
 * Distinct from `findMergedNets`, which looks for a shared label *point*. A
 * shared point is electrical — KiCad fuses the nets. Overlapping text is
 * cosmetic: the sheet reads badly, the netlist is right. Reported one entry per
 * colliding label position, nets sorted, so the same pair is not listed twice.
 */
export function findLabelOverlaps(
  labels: { name: string; x: number; y: number; rot: number; kind?: EmitLabel['kind'] }[],
): { x: number; y: number; nets: string[] }[] {
  const out = new Map<string, { x: number; y: number; nets: Set<string> }>();
  const boxes = labels.map((l) => labelTextBox(l.name, l.x, l.y, l.rot, l.kind));
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

/**
 * Draft, then check the drawn group boxes against one another: a box grows
 * past its tiling estimate when the text it must hold (a flag on a hung
 * part, a rail name at the edge) reaches further than the pin labels the
 * estimate counted, and two boxes then intersect (usb-atmega-node's Status
 * over IO Headers). Each overlap widens the right-hand group's left reserve
 * by the overlap and the sheet is drafted again; placement is a pure
 * function of the intent and these reserves, so the result stays
 * deterministic. Three rounds bound the cost.
 */
export function draftSchematicPlacement(validated: ValidatedIntent, projectName: string, today: string): { model: PlacementModel; report: SchematicDraftReport } {
  const reserves = new Map<string, { left: number; right: number }>();
  let frameSlack = 0;
  let wrapGap = 0;
  // The squeeze. The first draft sizes every cell by rule (a margin a side, a
  // power symbol's worth under every hung part, a label beside every pin) and
  // draws into that room; most of the room stays empty. Each further round
  // sizes the cells from what the previous round actually drew — body,
  // wires, labels, power symbols, field text of the cell and of everything
  // hung on it — plus a pad, and draws again. Rounds continue while the
  // group boxes shrink and the engine's own gates hold (no merged nets, the
  // label-overlap budget kept); the smallest passing sheet is the result.
  // This is the step a drafter does by eye after placing: look, then pull
  // things together.
  let measured: Map<string, Overhang> | undefined;
  let best: { model: PlacementModel; report: SchematicDraftReport; area: number; refusals: number; paperIdx: number } | null = null;
  let squeezeRounds = 0;
  let areaBefore = 0;
  const boxArea = (rects: { x1: number; y1: number; x2: number; y2: number }[]): number => rects.reduce((a, r) => a + (r.x2 - r.x1) * (r.y2 - r.y1), 0);
  let retries = 0;
  for (let round = 0; round < 16; round++) {
    const { model, report, rects, measured: nextMeasured } = draftOnce(validated, projectName, today, reserves, frameSlack, measured, wrapGap);
    let widened = false;
    // A row or column wrapped to the full usable width leaves no room for the
    // text its boxes grow to hold afterwards, and a box then crosses the
    // frame (usb-atmega-node's IO Headers on A3). Any box past the frame
    // shrinks the usable frame by the overflow and the sheet is drafted again.
    const paper = PAPERS.find((p) => p.name === report.sheetFit.paper);
    if (paper) {
      const over = Math.max(0, ...rects.flatMap((r) => [FRAME - r.x1, r.x2 - (paper.w - FRAME), FRAME - r.y1, r.y2 - (paper.h - FRAME)]));
      if (over > 0.01) {
        frameSlack += over + U;
        widened = true;
        trace(`a group box crosses the frame by ${over.toFixed(2)} mm; the usable frame shrinks by ${frameSlack.toFixed(2)} mm and the sheet is drafted again`);
      }
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (ox <= 0.01 || oy <= 0.01) continue;
        widened = true;
        if (oy < ox) {
          // boxes in different rows (or columns) touching along the wrap
          // gap: widen the gap between wrapped rows and columns
          wrapGap += oy + U;
          trace(`group boxes "${a.name}" and "${b.name}" overlap by ${oy.toFixed(2)} mm across the wrap; the wrap gap grows to ${wrapGap.toFixed(2)} mm and the sheet is drafted again`);
          continue;
        }
        const right = a.x1 < b.x1 ? b : a;
        const r = reserves.get(right.name) ?? { left: 0, right: 0 };
        r.left += ox + U;
        reserves.set(right.name, r);
        trace(`group boxes "${a.name}" and "${b.name}" overlap by ${ox.toFixed(2)} mm; "${right.name}" reserves ${r.left.toFixed(2)} mm more on its left and the sheet is drafted again`);
      }
    }
    if (widened && retries < 3) {
      retries++;
      continue; // the same cells, re-tiled: not a squeeze round
    }
    const area = boxArea(rects);
    const refusals = report.notes.filter((n) => /refused/.test(n)).length;
    const paperIdx = PAPERS.findIndex((p) => p.name === report.paper);
    // a round whose boxes still overlap or cross the frame after three
    // re-tilings is not a sheet to keep; nor one that lost a hung part, or
    // needs a larger sheet, or shrank by less than three percent
    const passes = !widened && report.mergedNets.length === 0 && !report.labelOverlapBudgetExceeded;
    retries = 0;
    reserves.clear();
    frameSlack = 0;
    wrapGap = 0;
    if (!best) {
      areaBefore = area;
      best = { model, report, area, refusals, paperIdx };
    } else if (passes && refusals <= best.refusals && paperIdx <= best.paperIdx && area < best.area * 0.97) {
      best = { model, report, area, refusals, paperIdx };
    } else {
      trace(`squeeze round ${squeezeRounds}: ${passes ? `boxes ${area.toFixed(0)} mm² did not shrink` : 'gates failed'}; keeping the previous round`);
      break;
    }
    // Rounds beyond the first run only when asked for: on the boards drafted
    // so far the rules were within a few percent of the drawing, and the
    // extra drafts cost time and re-pin every fixture. The measurement and
    // the report are always made.
    if (squeezeRounds >= 3 || process.env['COPPERHEAD_DRAFT_SQUEEZE'] !== '1') break;
    measured = nextMeasured;
    squeezeRounds++;
    trace(`squeeze round ${squeezeRounds}: cells measured, group boxes ${area.toFixed(0)} mm²; drafting again`);
  }
  const out = best!;
  out.report.sheetFit.squeeze = { rounds: squeezeRounds, boxAreaBefore: Math.round(areaBefore), boxAreaAfter: Math.round(out.area) };
  if (squeezeRounds > 0) {
    out.report.notes.push(`cells measured: group boxes ${Math.round(areaBefore / 1000)} k mm² to ${Math.round(out.area / 1000)} k mm² over ${squeezeRounds} round(s) on ${out.report.paper}`);
  }
  return { model: out.model, report: out.report };
}

function draftOnce(
  validated: ValidatedIntent,
  projectName: string,
  today: string,
  reserves: Map<string, { left: number; right: number }>,
  frameSlack = 0,
  measured?: Map<string, Overhang>,
  wrapGap = 0,
): { model: PlacementModel; report: SchematicDraftReport; rects: { name: string; x1: number; y1: number; x2: number; y2: number }[]; measured: Map<string, Overhang> } {
  // a measured round keeps only a small margin: the measured overhang says
  // where the drawing actually reaches
  const MARGIN = measured ? MEASURED_MARGIN : BASE_MARGIN;
  const { intent, symbols, docGroups } = validated;
  const notes: string[] = [];

  // ---------- net classification (deterministic, visible in the report) ----------
  const partByRef = new Map(intent.parts.map((p) => [p.ref, p]));

  // ---------- instance expansion (multi-unit parts, #218) ----------
  // Units none of whose OWN pins a net or no-connect references are left
  // unplaced (the intent says nothing about them, and drawing them would add
  // unconnected pins the intent never declared). Common (unit-0) pins do not
  // count as a unit's own: they appear in every unit's view because KiCad
  // draws them on every placed unit — an LM358's V+/V- reaching the rails
  // must not drag an unused second opamp onto the sheet. A multi-unit part
  // with NO referenced pins at all places all its units, so the part stays
  // visible like an unwired single-unit part does.
  const usedEps = new Set<string>();
  for (const net of intent.nets) for (const ep of net.pins) if (typeof ep === 'string') usedEps.add(ep);
  for (const ep of intent.noConnect ?? []) if (typeof ep === 'string') usedEps.add(ep);
  /** Endpoints of common (unit-0) pins: drawn — and wired — on EVERY placed
   * instance of their part. */
  const commonEps = new Set<string>();
  const instances: Instance[] = intent.parts.flatMap((p): Instance[] => {
    const sym = symbols.get(p.ref);
    if (!sym) return [];
    if (!sym.multiUnit || !sym.units?.length) return [{ key: p.ref, ref: p.ref, unit: null, part: p, sym }];
    const common = new Set(sym.commonUnitPins ?? []);
    for (const n of common) commonEps.add(`${p.ref}.${n}`);
    const referenced = sym.units.filter((u) =>
      u.pins.some((pin) => !common.has(pin.number) && usedEps.has(`${p.ref}.${pin.number}`)),
    );
    return (referenced.length ? referenced : sym.units).map((u) => ({
      key: `${p.ref}#${u.unit}`,
      ref: p.ref,
      unit: u.unit,
      part: p,
      sym: { ...sym, pins: u.pins, body: u.body },
    }));
  });
  const instByKey = new Map(instances.map((i) => [i.key, i]));
  /** The pin that controls a transistor (base or gate), or null for anything else. */
  const controlPinOf = (key: string): DraftPin | null => {
    const inst = instByKey.get(key);
    if (!inst || inst.sym.pins.length !== 3) return null;
    if (!/^Transistor|^Device:Q_|^Q\d/.test(inst.part.libId) && !/^Q\d/.test(inst.ref)) return null;
    return inst.sym.pins.find((p) => /^(B|G|Base|Gate)$/i.test(p.name)) ?? null;
  };
  const isTransistor = (key: string): boolean => controlPinOf(key) !== null;
  /** Switches are the anchors of a button block: the pull-up, the debounce
   * cap and the ESD diode all hang on the switch's signal pin. */
  const isSwitch = (key: string): boolean => /^Switch[:_]|^Device:SW_|^Button/i.test(instByKey.get(key)?.part.libId ?? '');
  /** Placed instances per refdes, for expanding a common pin's endpoint. */
  const instancesOfRef = new Map<string, Instance[]>();
  for (const inst of instances) instancesOfRef.set(inst.ref, [...(instancesOfRef.get(inst.ref) ?? []), inst]);
  const epInstKey = new Map<string, string>();
  for (const inst of instances) {
    for (const pin of inst.sym.pins) {
      const ep = `${inst.ref}.${pin.number}`;
      if (!commonEps.has(ep)) epInstKey.set(ep, inst.key);
    }
  }
  /** Placement-instance key owning endpoint REF.PIN. A common pin resolves to
   * its part's FIRST placed instance (single-instance callers — layering,
   * idiom passes — need one answer; the wiring passes use `expandEp` and
   * reach every appearance). Falls back to the ref itself so lookups fail
   * softly like before. */
  const instKeyOf = (ref: string, pin: string): string =>
    epInstKey.get(`${ref}.${pin}`) ?? instancesOfRef.get(ref)?.[0]?.key ?? ref;
  /** Every placed instance carrying endpoint REF.PIN: one for a unit's own
   * pin, all of the part's instances for a common pin. */
  const expandEp = (ref: string, pin: string): Instance[] => {
    if (commonEps.has(`${ref}.${pin}`)) return instancesOfRef.get(ref) ?? [];
    const inst = instByKey.get(instKeyOf(ref, pin));
    return inst ? [inst] : [];
  };

  const pinLookup = (ep: string): DraftPin | null => {
    const m = /^([^.]+)\.(.+)$/.exec(ep);
    if (!m) return null;
    const sym = symbols.get(m[1]!);
    return sym?.pins.find((p) => p.number === m[2]) ?? null;
  };
  const netClasses = new Map<string, { cls: NetClass; overridden: boolean; basis: NetClassBasis }>();
  for (const net of intent.nets) netClasses.set(net.name, classifyNet(net, pinLookup));
  const powerNets = intent.nets.filter((n) => netClasses.get(n.name)!.cls !== 'signal');
  const signalNets = intent.nets.filter((n) => netClasses.get(n.name)!.cls === 'signal');

  // ---------- reductions: decoupling caps and connectors ----------
  // Structural, not name-based (#233): the reduction's own conditions below
  // (a rail on one pin, ground on the other, an owner IC on the same rail)
  // are what make a part a decoupling element. Real boards carry their caps
  // under embedded, renamed lib ids the old `Device:C` test never matched,
  // so their banks stayed in the columns as label islands; and a rail-clamp
  // TVS drawn beside the caps is how the hand-drawn sheets show it too.
  const isTwoPin = (p: IntentPart): boolean => (symbols.get(p.ref)?.pins.length ?? 0) === 2;
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
    if (sym.isPower || !isTwoPin(p)) continue;
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
  const labelExtents = (keys: string[]): { left: number; right: number } => {
    let left = 0;
    let right = 0;
    for (const key of keys) {
      const inst = instByKey.get(key);
      if (!inst) continue;
      // a part with pins only on its top and bottom (a vertical R or C)
      // carries its reference and value beside it on the right
      if (inst.sym.pins.every((pin) => outward(pin).dx === 0)) {
        const fieldW = Math.max(inst.ref.length + 1, inst.part.value.length) * TEXT_RESERVE * LABEL_HEIGHT;
        right = Math.max(right, 1.27 + fieldW + 1.27);
      }
      for (const pin of inst?.sym.pins ?? []) {
        const o = outward(pin);
        if (o.dx === 0) continue;
        const ep = `${inst!.ref}.${pin.number}`;
        const signal = signalNetOfPin.get(ep);
        const power = signal ? undefined : netByEndpoint.get(ep);
        if (!signal && !power) continue;
        // a small signal net whose every endpoint is in this group is wired,
        // not labelled: no flag reaches out from it (counting one for every
        // pin put 27 mm between groups whose facing sides carry no label). A
        // larger in-group net may still end in stub labels, so it keeps its
        // reserve.
        if (signal) {
          const net = netByEndpoint.get(ep);
          const others = (net?.pins ?? []).filter((other) => other !== ep).map((other) => /^([^.]+)\./.exec(other)?.[1] ?? '');
          const leaves = !net || net.pins.length > MAX_WIRED_ENDPOINTS || others.some((ref) => partByRef.get(ref)?.group !== inst!.part.group);
          // only when every other endpoint is a two-lead part (or a test
          // point): those hang on the pin and are wired by construction; two
          // ICs of one group may still sit past wire span and take labels
          const hangs = others.every((ref) => (symbols.get(ref)?.pins.length ?? 3) <= 2);
          if (!leaves && hangs) continue;
        }
        // a signal: stub plus the label's flag (text, margins and tip); a
        // rail or ground on a sideways pin: the longer power stub, the bar,
        // and the name drawn outward in line
        const extent = signal
          ? STUB * U + Math.max(1, signal.length) * TEXT_RESERVE * LABEL_HEIGHT + FLAG_PAD
          : (STUB + 2) * U + 1.905 + Math.max(1, power!.name.length) * TEXT_RESERVE * LABEL_HEIGHT;
        if (o.dx === -1) left = Math.max(left, extent);
        else right = Math.max(right, extent);
      }
    }
    return { left, right };
  };
  /** Extra gap units so facing label text fits a boundary whose body-to-body
   * clearance is `baseUnits`: the two texts, the box padding each group draws
   * around its own text (`BOX_PAD` a side), and the gap between the boxes. */
  const widenBy = (rightOfPrev: number, leftOfNext: number, baseUnits: number): number =>
    Math.max(0, ceilU(rightOfPrev + leftOfNext) + 2 * BOX_PAD + BOX_GAP - baseUnits);

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
  /** Part key -> the anchor it was hung on or laid beside. A bound part is
   * wired to its anchor whatever the distance: the shelf placed it there
   * deliberately, and a lane past the wire span still belongs to its pin. */
  const boundTo = new Map<string, string>();
  const groupExtents = new Map<string, { left: number; right: number }>();
  for (const gname of groupNames) {
    const e = labelExtents(instances.filter((i) => i.part.group === gname && !i.sym.isPower).map((i) => i.key));
    const r = reserves.get(gname);
    groupExtents.set(gname, { left: e.left + (r?.left ?? 0), right: e.right + (r?.right ?? 0) });
  }

  /**
   * Place every group's cells. `bandBudgetW` caps a single group's width, in
   * grid units: a column that would tile past it starts a new band of columns
   * below the ones already placed (#219). `colBudgetH` caps a single column's
   * height, in grid units: a depth whose parts stack taller becomes several
   * side-by-side columns, the vertical analog of banding (#220 phase 4).
   * `Infinity` for both keeps the classic single-band ribbon. Placement is
   * deterministic in (intent, budgets), so the paper-selection pass below may
   * re-run it with tighter budgets when a sheet is worth compacting onto.
   * Returns each group's band count.
   */
  const placeAllGroups = (bandBudgetW: number, colBudgetH: number = Infinity): Map<string, number> => {
    placed.clear();
    groupRects.length = 0;
    groupOf.clear();
    const bandsOf = new Map<string, number>();
    let groupX = 0; // running x origin (units) for group tiling
    let prevGroup: string | null = null; // last group that actually placed cells

    for (const gname of groupNames) {
      // widen the gap to the previous group when facing label text needs it
      if (prevGroup !== null) {
        groupX += widenBy(groupExtents.get(prevGroup)!.right, groupExtents.get(gname)!.left, 2 * MARGIN + GROUP_GAP);
      }
      const members = instances.filter(
        (i) => i.part.group === gname && !i.sym.isPower && !decapOwner.has(i.key),
      );
      const caps = instances.filter((i) => i.part.group === gname && decapOwner.has(i.key));
      for (const i of [...members, ...caps]) groupOf.set(i.key, gname);
      const memberKeySet = new Set(members.map((m) => m.key));

      // layer assignment: connectors at depth 0; signal edges push depth forward
      const depth = new Map<string, number>(members.map((m) => [m.key, isConnector(m.part) ? 0 : 1]));
      const edges: { from: string; to: string }[] = [];
      for (const net of signalNets) {
        const eps = net.pins
          .map((ep) => {
            const m = /^([^.]+)\.(.+)$/.exec(ep);
            return m ? instKeyOf(m[1]!, m[2]!) : '';
          })
          .filter((k) => memberKeySet.has(k));
        const uniq = [...new Set(eps)];
        for (let i = 0; i < uniq.length; i++) {
          for (let j = i + 1; j < uniq.length; j++) {
            const [a, b] = [uniq[i]!, uniq[j]!].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
            edges.push({ from: a!, to: b! });
          }
        }
      }
      // The IC leads its group. Edges above are stored refdes-ordered, and
      // C, D, J, L, Q and R all sort before U, so plain propagation pushed
      // every IC to the deepest column on the right with its passives strung
      // out to its left — a reader looked for the part the group is about and
      // found it last. When a group has ICs (three or more pins, not a
      // connector), they anchor the first column after the connectors and
      // every other member sits at its signal-net hop distance from the
      // nearest IC; a member no signal path reaches stays beside the ICs.
      // A group with no IC keeps the edge propagation, where the connector
      // column is the only anchor there is.
      // A transistor is a three-pin part, but it is not what a group is
      // about: it belongs at the end of the run that drives its base, the way
      // a hand-drawn sheet puts a level shifter or a switch right on the pin.
      const groupIC = (key: string): boolean => instByKey.get(key)!.sym.pins.length >= 3 && !isConnector(instByKey.get(key)!.part) && !isTransistor(key);
      const anchors = members.filter((m) => groupIC(m.key)).map((m) => m.key);
      if (anchors.length) {
        // IC to IC, the signal flow still propagates (a chain of forty
        // stages is forty columns, not one), refdes-ordered as before
        const icSet = new Set(anchors);
        for (let iter = 0; iter < anchors.length; iter++) {
          let changed = false;
          for (const e of edges) {
            if (!icSet.has(e.from) || !icSet.has(e.to)) continue;
            const want = depth.get(e.from)! + 1;
            if (depth.get(e.to)! < want) {
              depth.set(e.to, want);
              changed = true;
            }
          }
          if (!changed) break;
        }
        // then every other member at its hop distance past the nearest IC,
        // never routing through a connector or another IC
        const adj = new Map<string, string[]>();
        for (const e of edges) {
          adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
          adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
        }
        const dist = new Map<string, number>(anchors.map((k) => [k, depth.get(k)!]));
        const queue = [...anchors].sort((a, b) => dist.get(a)! - dist.get(b)!);
        while (queue.length) {
          const k = queue.shift()!;
          for (const o of adj.get(k) ?? []) {
            if (dist.has(o) || isConnector(instByKey.get(o)!.part)) continue;
            dist.set(o, dist.get(k)! + 1);
            queue.push(o);
          }
        }
        for (const [k, d] of dist) if (!icSet.has(k)) depth.set(k, d);
      } else {
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
      }
      const depths = [...new Set([...depth.values()])].sort((a, b) => a - b);
      const columns: string[][] = depths.map((d) => members.filter((m) => depth.get(m.key) === d).map((m) => m.key));

      // barycenter row ordering (two sweeps), refdes as the deterministic
      // tie; an IC stays at the top of its column so the group reads from
      // its top-left corner
      const rowOf = new Map<string, number>();
      const lead = (ref: string): number => (groupIC(ref) ? 0 : 1);
      columns.forEach((col) => col.sort((a, b) => lead(a) - lead(b) || a.localeCompare(b, undefined, { numeric: true })).forEach((r, i) => rowOf.set(r, i)));
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
          col.sort((a, b) => lead(a) - lead(b) || bary(a) - bary(b) || a.localeCompare(b, undefined, { numeric: true })).forEach((r, i) => rowOf.set(r, i));
        }
      }

      // cells: sized from body plus margins, positions snapped to the grid
      const cellDims = new Map<string, { w: number; h: number; body: Bounds; shelfL: number; shelfR: number; topPad: number; usedL?: number; usedR?: number; reachL?: number; reachR?: number }>();
      for (const m of members) {
        const b = bodyBoundsOf(m.sym);
        const mo = measured?.get(m.key);
        if (mo) {
          // the cell is what the previous round drew around this body, a pad
          // past it on every side: the body sits at shelfL + MARGIN from the
          // cell's left edge and topPad + MARGIN from its top
          const shelfL = Math.max(0, ceilU(mo.left) + MEASURE_PAD - MARGIN);
          const shelfR = Math.max(0, ceilU(mo.right) + MEASURE_PAD - MARGIN);
          const topPad = Math.max(0, ceilU(mo.top) + MEASURE_PAD - VMARGIN);
          const below = Math.max(VMARGIN, ceilU(mo.bottom) + MEASURE_PAD);
          cellDims.set(m.key, {
            w: shelfL + MARGIN + ceilU(b.maxX - b.minX) + MARGIN + shelfR,
            h: topPad + VMARGIN + ceilU(b.maxY - b.minY) + below,
            body: b,
            shelfL,
            shelfR,
            topPad,
          });
          continue;
        }
        // a rail or ground on a pin facing up or down draws a stub, a bar and
        // a name past the body: that pin's side reserves the symbol's reach
        const powered = (dy: number): boolean =>
          m.sym.pins.some((p) => outward(p).dy === dy && netByEndpoint.has(`${m.ref}.${p.number}`) && (netClasses.get(netByEndpoint.get(`${m.ref}.${p.number}`)!.name)?.cls ?? 'signal') !== 'signal');
        const topReach = powered(-1) ? POWER_REACH : 0;
        const botReach = powered(1) ? POWER_REACH : 0;
        cellDims.set(m.key, {
          w: ceilU(b.maxX - b.minX) + 2 * MARGIN,
          h: Math.max(0, topReach - VMARGIN) + VMARGIN + ceilU(b.maxY - b.minY) + VMARGIN + Math.max(0, botReach - VMARGIN),
          body: b,
          shelfL: 0,
          shelfR: 0,
          topPad: Math.max(0, topReach - VMARGIN),
        });
      }

      // ---------- pin-anchored hangs (#220 phase 3) ----------
      // A drafter puts a part on the pin it serves: the compensation network
      // hangs off COMP, the bootstrap cap sits on BOOT, a pull-down drops from
      // its pin. Column placement put every such part in a column of its own
      // and let the wire pass decide later, so most of them ended as labelled
      // islands. Here, before any column is packed, each IC's side pins are
      // read in order and the chain of vertical two-lead parts a pin's net
      // leads into is claimed as a HANG: it will be drawn below the pin's
      // row in a shelf beside the IC, at the first slot whose rows are free,
      // and the IC's cell grows by the shelf so the columns start past it.
      // Hung parts leave the columns now; the chain pass below places them
      // once the IC has coordinates, with the same clearance check every
      // idiom uses, and a hang that cannot be placed cleanly falls back to a
      // column at the group's right edge.
      type Hang = { ic: string; pin: DraftPin; dx: -1 | 1; dir: -1 | 1; chain: string[]; slot: number; straight: boolean; w: number; h: number; ends: 'power' | 'open' };
      /** A run of two-lead parts laid ALONG the pin's row, away from the IC. */
      type Inline = { ic: string; pin: DraftPin; dx: -1 | 1; chain: { key: string; nearPin: string; gap: number }[]; len: number; farNet: string | null; offset: number };
      const hangs: Hang[] = [];
      const inlines: Inline[] = [];
      const hungKeys = new Set<string>();
      for (const [k, v] of boundTo) if (groupOf.get(k) === gname) boundTo.delete(k), void v;
      /**
       * The rotation (0, 90, 180, 270) that turns two-lead part `key` so that
       * pin `nearPin` faces direction `want` (schematic dx/dy) and its other
       * lead faces the opposite way; null when the part is not a two-lead
       * part with opposed leads. This is what lets a diode, LED, fuse or
       * switch (horizontal leads in the library) hang like a resistor, and a
       * resistor lie along a row like a diode.
       */
      /** A test point: one pin, probing the net it sits on. It hangs beside that net's pin. */
      const isTestPoint = (key: string): boolean => {
        const inst = instByKey.get(key);
        return !!inst && inst.sym.pins.length === 1 && (/TestPoint/i.test(inst.part.libId) || /^TP\d/.test(inst.ref));
      };

      const orientFor = (key: string, nearPin: string, want: { dx: number; dy: number }): number | null => {
        const pins = instByKey.get(key)?.sym.pins ?? [];
        if (pins.length !== 2 && !isTestPoint(key)) return null;
        for (const rot of [0, 90, 180, 270]) {
          const rs = rotatedSym(instByKey.get(key)!.sym, rot);
          const near = rs.pins.find((p) => p.number === nearPin);
          if (!near) return null;
          const on = outward(near);
          if (on.dx !== want.dx || on.dy !== want.dy) continue;
          if (pins.length === 1) return rot;
          const other = rs.pins.find((p) => p.number !== nearPin)!;
          const oo = outward(other);
          if (oo.dx === -want.dx && oo.dy === -want.dy) return rot;
        }
        return null;
      };
      /** Both leads of a two-lead part, un-rotated; a test point's one pin twice. */
      const leadsOf = (key: string): { a: DraftPin; b: DraftPin } | null => {
        const pins = instByKey.get(key)?.sym.pins ?? [];
        if (isTestPoint(key)) return { a: pins[0]!, b: pins[0]! };
        if (pins.length !== 2) return null;
        const oa = outward(pins[0]!);
        const ob = outward(pins[1]!);
        if (oa.dx !== -ob.dx || oa.dy !== -ob.dy) return null; // leads must oppose
        return { a: pins[0]!, b: pins[1]! };
      };
      const hangable = (key: string): boolean =>
        memberKeySet.has(key) &&
        !decapOwner.has(key) &&
        !hungKeys.has(key) &&
        !isConnector(instByKey.get(key)!.part) &&
        !/crystal|reson/i.test(instByKey.get(key)?.part.libId ?? '') &&
        leadsOf(key) !== null;
      /** Lead span along the hang or run, mm: connection point to connection
       * point, or for a test point the body's reach past its one pin. */
      const spanOf = (key: string, rot = 0): number => {
        const ctl = controlPinOf(key);
        if (ctl) {
          const b = bodyBoundsOf(instByKey.get(key)!.sym);
          return Math.max(b.maxX - ctl.x, ctl.x - b.minX);
        }
        const l = leadsOf(key)!;
        if (isTestPoint(key)) {
          const rs = rotatedSym(instByKey.get(key)!.sym, rot);
          const pin = rs.pins[0]!;
          const b = bodyBoundsOf(rs);
          const o = outward(pin);
          // the body lies opposite the pin's outward direction
          return o.dy !== 0 ? Math.max(0, o.dy === 1 ? b.maxY - pin.y : pin.y - b.minY) : Math.max(0, o.dx === 1 ? pin.x - b.minX : b.maxX - pin.x);
        }
        return Math.hypot(l.a.x - l.b.x, l.a.y - l.b.y);
      };
      const INLINE_GAP = 4 * U;
      /**
       * Claim a hang from IC pin `pin` starting at `first` (an endpoint of the
       * pin's net). `dir` 1 hangs down from the row, -1 rises above it; the
       * chain continues through two-endpoint links to a rail, a ground or a
       * tapped node. The part is turned so its near lead faces the row.
       */
      const claimHang = (icKey: string, pin: DraftPin, dx: -1 | 1, first: { key: string; pin: string }, dir: -1 | 1): void => {
        const chain = [first.key];
        const nearPins = [first.pin];
        hungKeys.add(first.key);
        boundTo.set(first.key, icKey);
        let ends: 'power' | 'open' = 'open';
        for (;;) {
          const cur = chain[chain.length - 1]!;
          if (isTestPoint(cur)) break;
          const l = leadsOf(cur)!;
          const near = nearPins[nearPins.length - 1]!;
          const far = l.a.number === near ? l.b : l.a;
          const beyond = netByEndpoint.get(`${instByKey.get(cur)!.ref}.${far.number}`);
          if (!beyond) break;
          if ((netClasses.get(beyond.name)?.cls ?? 'signal') !== 'signal') {
            ends = 'power';
            break;
          }
          if (beyond.pins.length !== 2) break;
          const next = beyond.pins.map(epKey).find((e) => e !== null && e.key !== cur);
          if (!next || !hangable(next.key) || chain.includes(next.key)) break;
          chain.push(next.key);
          nearPins.push(next.pin);
          hungKeys.add(next.key);
          boundTo.set(next.key, icKey);
        }
        let h = 0;
        let w = 0;
        for (const key of chain) {
          const inst = instByKey.get(key)!;
          // turned to hang: the body's extent across the axis and its span along it
          const rotH = orientFor(key, nearPins[chain.indexOf(key)]!, { dx: 0, dy: -dir }) ?? 0;
          const rs = rotatedSym(inst.sym, rotH);
          const b = bodyBoundsOf(rs);
          h += spanOf(key, rotH) + HANG_GAP;
          // a hung part is narrow: its body, the reference and value
          // beside it, and a unit of air — not the column cell's margins
          const fieldW = Math.max(inst.ref.length + 1, inst.part.value.length) * TEXT_RESERVE * LABEL_HEIGHT + 1.27;
          w = Math.max(w, b.maxX - b.minX + fieldW + U);
        }
        if (ends === 'power') h += HANG_POWER_END;
        hangs.push({ ic: icKey, pin, dx, dir, chain, slot: 0, straight: false, w, h, ends });
        hangNearPins.set(chain.join('+'), nearPins);
      };
      const hangNearPins = new Map<string, string[]>();
      const placedOffset = new Set<Inline>();
      /**
       * Claim a series run along the row from IC pin `pin`: `first` lies on
       * the row with its near lead toward the IC, and the run continues
       * through two-endpoint links while the next part is a two-lead part.
       * The far end gets whatever the wire pass gives it: a wire to a
       * connector on the row, or a label.
       */
      /** Gap before a part on a row: room for the wired net's name above the wire, at least one plain gap. */
      const gapFor = (netName: string): number => Math.max(INLINE_GAP, grid(ceilU(Math.max(1, netName.length) * TEXT_RESERVE * LABEL_HEIGHT + 2 * U) ));
      const claimInline = (icKey: string, pin: DraftPin, dx: -1 | 1, first: { key: string; pin: string }): void => {
        const pinNet = netByEndpoint.get(`${instByKey.get(icKey)!.ref}.${pin.number}`)?.name ?? '';
        const chain: { key: string; nearPin: string; gap: number }[] = [{ key: first.key, nearPin: first.pin, gap: gapFor(pinNet) }];
        hungKeys.add(first.key);
        boundTo.set(first.key, icKey);
        let farNet: string | null = null;
        for (let n = 0; n < 3; n++) {
          const cur = chain[chain.length - 1]!;
          if (isTransistor(cur.key)) {
            farNet = null; // the run ends in the transistor; its other pins take what the wire pass gives
            break;
          }
          const l = leadsOf(cur.key)!;
          const far = l.a.number === cur.nearPin ? l.b : l.a;
          const beyond = netByEndpoint.get(`${instByKey.get(cur.key)!.ref}.${far.number}`);
          farNet = beyond?.name ?? null;
          if (!beyond || beyond.pins.length !== 2) break;
          const next = beyond.pins.map(epKey).find((e) => e !== null && e.key !== cur.key);
          if (!next || chain.some((c) => c.key === next.key)) break;
          // a series resistor into a base or gate: the transistor ends the run,
          // turned so that pin faces the part that drives it
          if (isTransistor(next.key)) {
            if (!memberKeySet.has(next.key) || hungKeys.has(next.key) || controlPinOf(next.key)!.number !== next.pin) break;
            chain.push({ key: next.key, nearPin: next.pin, gap: gapFor(beyond.name) });
            hungKeys.add(next.key);
            boundTo.set(next.key, icKey);
            farNet = null;
            break;
          }
          if (!hangable(next.key)) break;
          chain.push({ key: next.key, nearPin: next.pin, gap: gapFor(beyond.name) });
          hungKeys.add(next.key);
          boundTo.set(next.key, icKey);
        }
        let len = 0;
        for (const c of chain) len += c.gap + spanOf(c.key);
        // room for the label the far end may carry
        if (farNet) len += STUB * U + Math.max(1, farNet.length) * TEXT_RESERVE * LABEL_HEIGHT;
        inlines.push({ ic: icKey, pin, dx, chain, len, farNet, offset: 0 });
      };
      const epKey = (ep: string): { key: string; pin: string } | null => {
        const m = /^([^.]+)\.(.+)$/.exec(ep);
        return m ? { key: instKeyOf(m[1]!, m[2]!), pin: m[2]! } : null;
      };
      // Three units, not four: a hung part's near stub ends one unit past
      // the gap, and pins sit two units apart, so an even gap parks that
      // stub end exactly on the neighbouring pin's row, where any run along
      // that row would join it (every single pull-up beside a pull-down on
      // the next pin was refused for this). An odd gap keeps it between rows.
      const HANG_GAP = 3 * U;
      /**
       * How far the labels on one side of an anchor actually reach, given
       * what has been claimed on it: a pin whose parts hang carries no stub
       * label any more, only its run's name (and only when the net has
       * endpoints elsewhere), so the lanes may start that much closer to the
       * IC. `labelExtents` assumes a stub label on every pin and put the
       * lanes 15 mm further out than the drawing needed.
       */
      const sideReach = (icKey: string, dx: -1 | 1): number => {
        const ic = instByKey.get(icKey)!;
        let reach = 0;
        for (const pin of ic.sym.pins) {
          if (outward(pin).dx !== dx) continue;
          const net = netByEndpoint.get(`${ic.ref}.${pin.number}`);
          if (!net) continue;
          const nameW = Math.max(1, net.name.length) * TEXT_RESERVE * LABEL_HEIGHT;
          if ((netClasses.get(net.name)?.cls ?? 'signal') !== 'signal') {
            reach = Math.max(reach, (STUB + 2) * U + 1.905 + nameW);
            continue;
          }
          const eps = net.pins.map(epKey);
          const claimed = eps.some((e) => e !== null && boundTo.get(e.key) === icKey);
          const elsewhere = eps.some((e) => e === null || (e.key !== icKey && !memberKeySet.has(e.key) && !decapOwner.has(e.key)));
          if (claimed) reach = Math.max(reach, elsewhere ? nameW + FLAG_PAD + U : STUB * U);
          else reach = Math.max(reach, STUB * U + nameW + FLAG_PAD);
        }
        return reach;
      };
      const HANG_POWER_END = 5 * U;
      /** Rows a power symbol and its name need past a pin: stub, bar, text. */
      const POWER_CLEAR_ROWS = 6;
      // Parts hang on ICs first, then on connectors and switches: a fuse
      // rises from the jack's pin, a button's pull-up, debounce cap and ESD
      // diode hang on the switch's signal pin. A switch already hung on an
      // IC pin (a reset button dropping from EN) anchors nothing itself.
      const claimAnchors = [
        ...anchors,
        ...members.filter((m) => !anchors.includes(m.key) && (isConnector(m.part) || isSwitch(m.key))).map((m) => m.key),
      ];
      for (const icKey of claimAnchors) {
        if (hungKeys.has(icKey)) continue;
        const ic = instByKey.get(icKey)!;
        const sidePins = ic.sym.pins
          .filter((p) => outward(p).dx !== 0)
          .sort((a, b) => b.y - a.y || a.x - b.x); // top row first (symbol y is up)
        for (const pin of sidePins) {
          const dx = outward(pin).dx as -1 | 1;
          const net = netByEndpoint.get(`${ic.ref}.${pin.number}`);
          if (!net || (netClasses.get(net.name)?.cls ?? 'signal') !== 'signal') continue;
          // the wire pass draws this net only if it stays in the group with
          // few endpoints; a net that will be labelled anyway gives no hang
          const eps = net.pins.map(epKey).filter((e): e is { key: string; pin: string } => e !== null);
          // A net that leaves the group or carries more endpoints than the
          // wire pass joins still hangs its local parts: the pull-up on a
          // fault line that also goes to the MCU, the RC on a button the
          // MCU reads. The wire pass joins the pin and its hung parts as
          // one local run and labels it once for the rest of the net
          // (esp32-amp shipped fourteen such parts as labelled islands).
          if (eps.length > MAX_WIRED_ENDPOINTS) trace(`${ic.ref}.${pin.number} ${net.name}: ${eps.length} endpoints, local parts still hang`);
          // a crystal's load caps belong to the flanking idiom below
          if (eps.some((e) => /crystal|reson/i.test(instByKey.get(e.key)?.part.libId ?? ''))) continue;
          // the chain enters the first part through whichever lead is on the
          // pin's net: through the top lead it hangs DOWN from the row,
          // through the bottom lead it rises above it (the pull-up shape)
          // every hangable endpoint of the pin's net hangs, each as its own
          // chain: a compensation network is a series RC AND a shunt C on
          // one pin, and leaving the shunt in a far column keeps the whole
          // net past wire span, labelled
          /** The net on the lead of `key` that is NOT `nearPin`. */
          const farNetOf = (key: string, nearPin: string): IntentNet | undefined => {
            const l = leadsOf(key)!;
            const far = l.a.number === nearPin ? l.b : l.a;
            return netByEndpoint.get(`${instByKey.get(key)!.ref}.${far.number}`);
          };
          /** Bridges from this pin to another pin of the IC, resolved after the pin's other parts. */
          const pinBridges: { first: { key: string; pin: string }; otherPin: DraftPin; othersOnPin: boolean }[] = [];
          for (const first of eps) {
            if (first.key === icKey) continue;
            // a transistor driven straight from the pin lies on the row, base to the pin
            if (isTransistor(first.key) && memberKeySet.has(first.key) && !hungKeys.has(first.key) && controlPinOf(first.key)!.number === first.pin) {
              trace(`${ic.ref}.${pin.number} ${net.name}: ${instByKey.get(first.key)!.ref} lies on the row (transistor)`);
              claimInline(icKey, pin, dx, first);
              continue;
            }
            if (!hangable(first.key)) {
              const why = !memberKeySet.has(first.key) ? 'not a group member' : decapOwner.has(first.key) ? 'a decoupling cap' : hungKeys.has(first.key) ? 'already claimed' : isConnector(instByKey.get(first.key)!.part) ? 'a connector' : leadsOf(first.key) === null ? 'not a two-lead part' : 'a crystal';
              trace(`${ic.ref}.${pin.number} ${net.name}: ${instByKey.get(first.key)!.ref} not hangable (${why})`);
              continue;
            }
            // a test point rises above the row of the pin it probes
            if (isTestPoint(first.key)) {
              claimHang(icKey, pin, dx, first, -1);
              continue;
            }
            // Look to the END of the run this part starts, through two-endpoint
            // links: a run that ends on a rail or ground is a SHUNT and hangs
            // from the row — rising to a rail (a pull-up), dropping to ground
            // (a pull-down, a filter cap, a series RC to ground). A run whose
            // far net returns to a pin of this IC BRIDGES the two pins and
            // hangs toward the other pin's row so that net stays within wire
            // span (a bootstrap cap between BST and OUT). Everything else is
            // a SERIES element — a 100 Ω in an I2S line, an output inductor —
            // and lies along the row, away from the IC, the way the reference
            // sheet draws it.
            let cur = first;
            let farNet = farNetOf(cur.key, cur.pin);
            const seen = new Set([first.key]);
            for (let n = 0; n < 4 && farNet && (netClasses.get(farNet.name)?.cls ?? 'signal') === 'signal' && farNet.pins.length === 2; n++) {
              const next = farNet.pins.map(epKey).find((e) => e !== null && e.key !== cur.key);
              if (!next || !hangable(next.key) || seen.has(next.key)) break;
              seen.add(next.key);
              cur = next;
              farNet = farNetOf(cur.key, cur.pin);
            }
            const farCls = farNet ? (netClasses.get(farNet.name)?.cls ?? 'signal') : null;
            // A bridge (the far net returns to another pin of this IC) lies
            // on the row of the pin that has NOTHING ELSE on it: claimed
            // from the busier pin it blocked that pin's row, and the series
            // part behind it could not be wired (esp32-amp's C28 on OUT_LN
            // left L3 a labelled island while C27 on BST_AP let L2 wire).
            const bridgeEp = cur.key === first.key && farNet && farCls === 'signal' && farNet.pins.length === 2
              ? farNet.pins.find((ep) => ep.startsWith(`${ic.ref}.`) && ep !== `${ic.ref}.${pin.number}`)
              : undefined;
            const otherPin = bridgeEp ? ic.sym.pins.find((p) => `${ic.ref}.${p.number}` === bridgeEp) : undefined;
            if (otherPin) {
              const others = eps.filter((e) => e.key !== icKey && e.key !== first.key && (hangable(e.key) || boundTo.get(e.key) === icKey));
              pinBridges.push({ first, otherPin, othersOnPin: others.length > 0 });
              continue;
            }
            // A part between two pins of this IC (a bootstrap cap between
            // BST and OUT) lies along its row too: hung, its far lead
            // landed rows away from the other pin and that pin's branch ran
            // along a third row under a label. On the row, the far net
            // reaches the other pin's row through the router's trunk.
            // A bridge to another pin of this IC (a bootstrap cap between BST
            // and SW) hangs in a lane toward that pin's row, its far lead
            // joined to that row by one short jog: laid along the row it sat
            // past every lane and every series part, and the bank under the
            // group followed the row out (rails 112 mm wide, 91 by hand).
            if (farCls === 'ground') {
              trace(`${ic.ref}.${pin.number} ${net.name}: ${instByKey.get(first.key)!.ref} hangs down (to ${farNet!.name})`);
              claimHang(icKey, pin, dx, first, 1);
            } else if (farCls === 'rail') {
              trace(`${ic.ref}.${pin.number} ${net.name}: ${instByKey.get(first.key)!.ref} rises (to ${farNet!.name})`);
              claimHang(icKey, pin, dx, first, -1);
            } else {
              trace(`${ic.ref}.${pin.number} ${net.name}: ${instByKey.get(first.key)!.ref} lies on the row (far net ${farNet?.name ?? 'none'})`);
              claimInline(icKey, pin, dx, first);
            }
          }
          // A bridge cap (BST to SW) hangs in the lane this pin already has,
          // toward the other pin's row, when the pin has a hang to share the
          // lane with (the buck's L1 rising from SW): one axis, one T, and the
          // other row reaches the cap's far lead with a single jog. With no
          // lane of its own to join it stays on the row (hung alone it cost
          // four attachments on the amplifier's four bootstrap pairs); and it
          // is left to the other pin when this pin carries series parts and
          // that pin carries nothing else.
          const pinHasHang = hangs.some((hg) => hg.ic === icKey && hg.pin.number === pin.number);
          for (const b of pinBridges) {
            if (hungKeys.has(b.first.key)) continue;
            if (pinHasHang) {
              const dir: -1 | 1 = b.otherPin.y < pin.y ? 1 : -1; // symbol y is up: a lower pin means dropping
              trace(`${ic.ref}.${pin.number} ${net.name}: ${instByKey.get(b.first.key)!.ref} bridges to ${ic.ref}.${b.otherPin.number}; shares the pin's lane, ${dir === 1 ? 'down' : 'up'}`);
              claimHang(icKey, pin, dx, b.first, dir);
            } else if (b.othersOnPin) {
              trace(`${ic.ref}.${pin.number} ${net.name}: ${instByKey.get(b.first.key)!.ref} bridges to ${ic.ref}.${b.otherPin.number}; left for that pin`);
            } else {
              trace(`${ic.ref}.${pin.number} ${net.name}: ${instByKey.get(b.first.key)!.ref} bridges to ${ic.ref}.${b.otherPin.number}; lies on the row`);
              claimInline(icKey, pin, dx, b.first);
            }
          }
        }
        // Slots per side. A hang whose rows are free of every other pin on
        // that side stays dead straight on its stub axis (AC-16.31: the wire
        // from the pin continues into the chain with no bend); the rest take
        // the first shelf slot whose rows are free. Rows are relative to the
        // IC origin, y down; symbol pin y is up.
        for (const dx of [-1, 1] as const) {
          const side = hangs.filter((hg) => hg.ic === icKey && hg.dx === dx);
          const inlineSide = inlines.filter((il) => il.ic === icKey && il.dx === dx);
          // Two horizontal parts on rows one pitch apart cannot share an x
          // range: a run on a row next to an earlier run starts past that
          // run's end (the reference sheet's output filter alternates the
          // inductor and the cap across its rows for the same reason).
          // a part lying on a row carries its reference above and its value
          // below, so its texts reach the neighbouring rows: runs within
          // three rows of each other stagger (two left C27's value under L3's
          // reference)
          const ROWS_NEAR = 3 * 2.54 + 0.01;
          for (const il of [...inlineSide].sort((a, b) => b.pin.y - a.pin.y)) {
            let offset = 0;
            for (;;) {
              const clash = inlineSide.find(
                (o) => o !== il && o.offset !== undefined && placedOffset.has(o) && Math.abs(o.pin.y - il.pin.y) <= ROWS_NEAR && offset < o.offset + o.len && offset + il.len > o.offset,
              );
              if (!clash) break;
              offset = clash.offset + clash.len + INLINE_GAP;
            }
            il.offset = offset;
            placedOffset.add(il);
          }
          if (!side.length && !inlineSide.length) continue;
          // any connected neighbour blocks the straight axis: a signal pin's
          // stub end sits on it, and a rail or ground pin's longer stub
          // crosses it — legal, but a wire through the IC's supply stubs is
          // exactly the crossing a drafter moves a part to avoid (the Tier C
          // divider drew two of them). A no-connect neighbour blocks nothing.
          const sidePinYs = ic.sym.pins
            .filter((p) => outward(p).dx === dx && netByEndpoint.has(`${ic.ref}.${p.number}`))
            .map((p) => -p.y);
          const pitch = Math.max(0, ...side.map((hg) => hg.w)) + U;
          const slots: { top: number; bot: number }[][] = [];
          let anyShelved = false;
          // Slot order matters: a lower pin's branch runs along its row from
          // the stub to its chain's axis, and a chain hanging down from a
          // higher pin must not cross that row inside the branch's span. So
          // down-hangs take slots from the lowest pin upward and up-hangs from
          // the highest pin downward: the chain that passes other pins' rows
          // is always the outer one, and every branch stays clear of every
          // sibling's stub end (esp32-amp's RT branch ran into the COMP
          // hang's stub end the first time).
          // Slots go to PINS, not hangs: a part rising and a part dropping
          // from one pin share one axis — the divider on its pin — and meet
          // the row in a single T. A slot's occupied range runs from the pin
          // ROW to the chain end, because the branch along the row belongs
          // to it: measured from the first part instead, a chain rising from
          // a lower pin shared its slot with the higher pin's drop and the
          // two axes met on that pin's row (esp32-amp's USB_OV divider was
          // refused for exactly that, four hangs on two adjacent pins).
          // One axis carries at most one chain up and one chain down; a
          // third chain on the same pin (the NTC divider's cap beside its
          // thermistor) takes the next lane out, and each lane is slotted as
          // its own group.
          const byPin = new Map<string, Hang[]>();
          for (const hg of side) byPin.set(hg.pin.number, [...(byPin.get(hg.pin.number) ?? []), hg]);
          const pinRow = (g: Hang[]): number => -g[0]!.pin.y;
          const pinGroups: Hang[][] = [];
          for (const hgs of byPin.values()) {
            const ups = hgs.filter((hg) => hg.dir === -1);
            const downs = hgs.filter((hg) => hg.dir === 1);
            for (let i = 0; i < Math.max(ups.length, downs.length); i++) {
              const lane = [ups[i], downs[i]].filter((hg): hg is Hang => hg !== undefined);
              pinGroups.push(lane);
            }
          }
          const ordered = [
            ...pinGroups.filter((g) => g.some((hg) => hg.dir === 1)).sort((a, b) => pinRow(b) - pinRow(a)),
            ...pinGroups.filter((g) => g.every((hg) => hg.dir === -1)).sort((a, b) => pinRow(a) - pinRow(b)),
          ];
          const lowRowAll = Math.max(...side.map((hg) => -hg.pin.y));
          const highRowAll = Math.min(...side.map((hg) => -hg.pin.y));
          for (const g of ordered) {
            const rowY = pinRow(g);
            const top = Math.min(rowY, ...g.map((hg) => (hg.dir === -1 ? highRowAll - HANG_GAP - hg.h : rowY)));
            const bot = Math.max(rowY, ...g.map((hg) => (hg.dir === 1 ? lowRowAll + HANG_GAP + hg.h : rowY)));
            // the clearance check pads the axis range by four units past the
            // pin row and the chain end, so a neighbour that close blocks it
            // the same five units (four of pad plus one) the clearance check
            // itself applies, else a neighbour exactly at the edge passes here
            // and refuses there (J1's fuse against the CC1 pin two rows down)
            const straight = !sidePinYs.some((y) => y !== rowY && y > top - 5 * U && y < bot + 5 * U);
            for (const hg of g) hg.straight = straight;
            if (straight) continue;
            anyShelved = true;
            let k = 0;
            while ((slots[k] ?? []).some((iv) => top < iv.bot + 2 * U && bot > iv.top - 2 * U)) k++;
            (slots[k] ??= []).push({ top, bot });
            for (const hg of g) hg.slot = k;
          }
          const dims = cellDims.get(icKey)!;
          const ext = labelExtents([icKey]);
          // Lanes come first, past the side's labels; the inline runs start
          // beyond the lanes. A part lying on the row between the stub and
          // the lanes blocked the row for the pin's own hung parts (Q1 on
          // VBUS_FET_EN left R17 unreachable), and a run on another row
          // starting inside the lanes crossed their bodies.
          const laneReach = sideReach(icKey, dx);
          void ext;
          const lanesW = anyShelved ? slots.length * pitch : 0;
          for (const il of inlineSide) il.offset += anyShelved ? ceilU(laneReach + 2 * U) * U + lanesW : 0;
          const inlineW = Math.max(0, ...inlineSide.map((il) => il.offset + il.len));
          // shelf: the IC's own labels, the stub, the lanes, then the runs. A
          // straight hang sits within the stub and the cell's own margin and
          // channel, so a side whose hangs are all straight and carries no
          // inline run reserves nothing (a five-part board went from A5 to A4
          // when it did).
          const shelf = anyShelved ? ceilU(laneReach + STUB * U) + 2 + Math.ceil(lanesW / U) + (inlineSide.length ? ceilU(inlineW - lanesW - laneReach) : 0) : inlineSide.length ? ceilU(inlineW + STUB * U) + 2 : 0;
          if (!measured?.has(icKey)) {
            if (dx === 1) dims.shelfR = shelf;
            else dims.shelfL = shelf;
            dims.w += shelf;
          }
          // y-down relative to the IC origin: the body spans -maxY..-minY
          const lowRow = Math.max(...side.map((hg) => -hg.pin.y));
          const highRow = Math.min(...side.map((hg) => -hg.pin.y));
          const deepest = Math.max(-dims.body.minY, ...side.map((hg) => (hg.dir === 1 ? (hg.straight ? -hg.pin.y : lowRow) + HANG_GAP + hg.h : -hg.pin.y)), ...inlineSide.map((il) => -il.pin.y + 3 * U));
          // what this side uses below the body's top, and how far its labels
          // reach: the shelf below that is free for the infill pass
          const laneDepth = Math.max(-dims.body.maxY, ...side.map((hg) => (hg.dir === 1 ? (hg.straight ? -hg.pin.y : lowRow) + HANG_GAP + hg.h : -hg.pin.y)), ...inlineSide.map((il) => -il.pin.y + 3 * U));
          const usedBelow = ceilU(laneDepth - -dims.body.maxY) + 2;
          if (dx === 1) {
            dims.usedR = usedBelow;
            dims.reachR = ceilU(laneReach + 2 * U);
          } else {
            dims.usedL = usedBelow;
            dims.reachL = ceilU(laneReach + 2 * U);
          }
          const highest = Math.min(-dims.body.maxY, ...side.map((hg) => (hg.dir === -1 ? (hg.straight ? -hg.pin.y : highRow) - HANG_GAP - hg.h : -hg.pin.y)));
          // an inline run lies on its row; a transistor at its end reaches two
          // rows above and below it (collector and emitter stubs)
          for (const il of inlineSide) {
            for (const c of il.chain) {
              if (!controlPinOf(c.key)) continue;
              const b = bodyBoundsOf(instByKey.get(c.key)!.sym);
              const reach = Math.max(b.maxY, -b.minY) + STUB * U + POWER_CLEAR_ROWS * U;
              if (measured?.has(icKey)) continue;
              dims.topPad = Math.max(dims.topPad, ceilU(-dims.body.maxY - (-il.pin.y - reach)));
              dims.h = Math.max(dims.h, ceilU(Math.max(deepest, -il.pin.y + reach) - Math.min(highest, -il.pin.y - reach)) + VMARGIN + 2);
            }
          }
          if (!measured?.has(icKey)) {
            dims.topPad = Math.max(dims.topPad, ceilU(-dims.body.maxY - highest));
            // the chain's end already carries the symbol's own room; two
            // units of air below it, not a full margin (a button block's cell
            // was 39 mm tall where a drafter draws it on a 25 mm pitch)
            dims.h = Math.max(dims.h, ceilU(deepest - highest) + VMARGIN + 2);
          }
        }
      }
      // Node hangs: the far end of a series run is a node too. An RC filter's
      // cap, a button's debounce cap and ESD diode sit on the net PAST the
      // series resistor, so they hang from the run's last part, dropping or
      // rising from the row just beyond its far lead, the first straight down
      // from the row's end and the rest on lanes past it.
      const nodeAnchors = new Set<string>();
      for (const il of [...inlines]) {
        const last = il.chain[il.chain.length - 1]!;
        if (isTransistor(last.key)) continue;
        const l = leadsOf(last.key)!;
        const farPin = l.a.number === last.nearPin ? l.b : l.a;
        const farNet = netByEndpoint.get(`${instByKey.get(last.key)!.ref}.${farPin.number}`);
        if (!farNet || (netClasses.get(farNet.name)?.cls ?? 'signal') !== 'signal') continue;
        const eps = farNet.pins.map(epKey).filter((e): e is { key: string; pin: string } => e !== null);
        let lanes = 0;
        for (const first of eps) {
          if (first.key === last.key || !hangable(first.key)) continue;
          const fl = leadsOf(first.key)!;
          const far = fl.a.number === first.pin ? fl.b : fl.a;
          const beyond = netByEndpoint.get(`${instByKey.get(first.key)!.ref}.${far.number}`);
          const cls = beyond ? (netClasses.get(beyond.name)?.cls ?? 'signal') : null;
          if (cls !== 'ground' && cls !== 'rail') continue; // only shunts; a second series part is a network
          trace(`${instByKey.get(last.key)!.ref}.${farPin.number} ${farNet.name} (node): ${instByKey.get(first.key)!.ref} ${cls === 'ground' ? 'hangs down' : 'rises'}`);
          claimHang(last.key, farPin, il.dx, first, cls === 'ground' ? 1 : -1);
          const hg = hangs[hangs.length - 1]!;
          hg.slot = lanes;
          hg.straight = lanes === 0;
          lanes++;
          nodeAnchors.add(last.key);
        }
        if (!lanes) continue;
        // the run's owner reserves the lanes and the drop below them
        const nodeHangs = hangs.filter((hg) => hg.ic === last.key);
        const pitch = Math.max(0, ...nodeHangs.map((hg) => hg.w)) + U;
        const add = (lanes - 1) * pitch + 2 * U + Math.max(0, ...nodeHangs.map((hg) => hg.w)) / 2;
        il.len += add;
        const dims = cellDims.get(il.ic)!;
        if (measured?.has(il.ic)) continue;
        if (il.dx === 1) dims.shelfR += ceilU(add);
        else dims.shelfL += ceilU(add);
        dims.w += ceilU(add);
        const rowRel = -il.pin.y;
        const hDown = Math.max(0, ...nodeHangs.filter((hg) => hg.dir === 1).map((hg) => hg.h));
        const hUp = Math.max(0, ...nodeHangs.filter((hg) => hg.dir === -1).map((hg) => hg.h));
        const bottom = Math.max(-dims.body.minY, rowRel + HANG_GAP + hDown);
        const top = Math.min(-dims.body.maxY, rowRel - HANG_GAP - hUp);
        dims.topPad = Math.max(dims.topPad, ceilU(-dims.body.maxY - top));
        dims.h = Math.max(dims.h, ceilU(bottom - top) + VMARGIN + 2);
      }
      void nodeAnchors;
      for (const col of columns) {
        for (let i = col.length - 1; i >= 0; i--) if (hungKeys.has(col[i]!)) col.splice(i, 1);
      }
      for (let i = columns.length - 1; i >= 0; i--) if (!columns[i]!.length) columns.splice(i, 1);
      // The budget must leave room for the label TEXT facing the sheet edges:
      // a band filled to the full usable width puts the leftmost column's
      // left-facing labels outside the frame (#220 phase 1), and no later
      // shift can fix both edges at once.
      const ext = groupExtents.get(gname)!;
      const bandW = Math.max(1, bandBudgetW - ceilU(ext.left) - ceilU(ext.right));

      // Height the decoupling bank adds UNDER the columns once they span
      // `blockW` units: the same row-wrap the bank placement below performs.
      const bankHeight = (blockW: number): number => {
        if (!caps.length) return 0;
        const capBudget = Math.min(bandW, Math.max(64, blockW));
        let rows = 1;
        let x = 0;
        for (const c of caps) {
          const b = bodyBoundsOf(c.sym);
          const w = ceilU(b.maxX - b.minX) + 2 * MARGIN;
          if (x > 0 && x + w > capBudget) {
            rows++;
            x = 0;
          }
          x += w;
        }
        return MARGIN + 4 + rows * (2 * MARGIN + 6);
      };
      // Column height budget (#220 phase 4): a depth whose parts stack taller
      // than the budget splits into several side-by-side columns, in row
      // order, so a 24-part board stops drafting as one full-height strip on
      // a sheet two sizes too large. Cells never shrink; only the arrangement
      // changes, so readability is untouched.
      //
      // The bank sits under the columns and counts against the SAME budget:
      // a group whose columns already fit the budget got no shorter under the
      // compaction retries while its bulk-cap rows pushed the group past the
      // sheet (a 30-part power-input group missed A1 by 8 mm that way). The
      // bank's rows are estimated at the columns' pre-split width — a lower
      // bound on the width they end up with, so an upper bound on rows.
      const colsW =
        columns.reduce((s, col) => s + Math.max(...col.map((r) => cellDims.get(r)!.w)), 0) +
        CHANNEL * Math.max(0, columns.length - 1);
      const sheetBudget = colBudgetH === Infinity ? Infinity : Math.max(1, colBudgetH - bankHeight(colsW));

      // ---------- in-group column balance ----------
      // A depth whose parts stack into one strip draws the group as a tall
      // thin column beside a short IC with the rest of the box empty: an
      // amplifier group put 20 filter caps in one 500 mm column next to a
      // 120 mm IC, and the box was two-thirds air. A drafter runs such parts
      // in several columns no taller than the IC they serve. So every column
      // is budgeted at the taller of the group's tallest IC cell and the side
      // of the square the group's cells would fill, and one taller than that
      // splits into equal-height side-by-side columns. The IC's CELL, not its
      // column: a transistor or an eFuse sharing a column with eight
      // resistors must not make that strip the reference height. Row order
      // is preserved chunk by chunk, exactly as the sheet budget splits, so
      // barycenter ordering and the trunk idioms are untouched.
      const colH = (col: string[]): number => col.reduce((s, r, i) => s + cellDims.get(r)!.h + (i ? ROW_GAP : 0), 0);
      const isIC = (key: string): boolean => instByKey.get(key)!.sym.pins.length >= 3;
      const anchorH = Math.max(0, ...members.filter((m) => isIC(m.key)).map((m) => cellDims.get(m.key)!.h));
      const cellArea = columns.reduce((s, c) => s + colH(c) * Math.max(...c.map((r) => cellDims.get(r)!.w)), 0);
      const squareSide = Math.ceil(Math.sqrt(cellArea));
      // Under a band budget the group is shaped to FILL the band's width, not
      // to be square: a column of eight test points re-rows into two of four
      // and the button blocks stack three deep, the grid a person draws when
      // the group must sit in a 250 mm column (esp32-amp's UI group went
      // from 364 × 150 to the width of its neighbours).
      // A group with no IC to lead it (buttons, test points, LEDs) has no
      // natural shape, and its columns line up as a strip five blocks wide;
      // shape it no wider than twice its square side, the grid a person
      // draws. Groups led by an IC keep the IC's own proportions.
      const shapeToAspect = anchors.length === 0;
      const aspectBand = Math.ceil(2.5 * squareSide);
      const searchBand = shapeToAspect ? Math.min(aspectBand, bandW) : bandW;
      const targetH = shapeToAspect
        ? Math.max(Math.ceil(cellArea / searchBand), Math.ceil(squareSide / 2))
        : bandBudgetW === Infinity
          ? squareSide
          : Math.max(Math.ceil(cellArea / bandBudgetW), Math.ceil(squareSide / 2));
      const balanceH = Math.max(anchorH, targetH);

      /** Split `col` into the fewest equal-height chunks that each fit
       * `budget`; a single cell never splits, and a column shorter than
       * `minCells` is left alone (a drafter does not re-row three parts). */
      const splitColumn = (col: string[], budget: number, minCells = 1): string[][] => {
        const total = colH(col);
        if (total <= budget || col.length < minCells) return [col];
        const k = Math.ceil(total / budget);
        const fill = (cap: number): string[][] => {
          const chunks: string[][] = [];
          let cur: string[] = [];
          let h = 0;
          for (const ref of col) {
            const add = cellDims.get(ref)!.h + (cur.length ? ROW_GAP : 0);
            if (cur.length && h + add > cap) {
              chunks.push(cur);
              cur = [ref];
              h = cellDims.get(ref)!.h;
            } else {
              cur.push(ref);
              h += add;
            }
          }
          if (cur.length) chunks.push(cur);
          return chunks;
        };
        // Balanced chunks first, for the look of level columns: the split of
        // the column into k consecutive chunks that minimises the tallest
        // chunk (a greedy fill to an equal target fell 7-1 on eight test
        // points of two heights, and 2-2-1 on five equal cells). If even
        // that tallest chunk is over the budget, fill to the budget instead.
        const hs = col.map((ref) => cellDims.get(ref)!.h);
        const n = hs.length;
        const runH = (i: number, j: number): number => hs.slice(i, j + 1).reduce((a, b) => a + b, 0) + ROW_GAP * (j - i);
        const bestMax: number[][] = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity));
        const cutAt: number[][] = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(0));
        bestMax[0]![0] = 0;
        for (let parts = 1; parts <= k; parts++) {
          for (let j = 1; j <= n; j++) {
            for (let i = parts - 1; i < j; i++) {
              const v = Math.max(bestMax[parts - 1]![i]!, runH(i, j - 1));
              if (v < bestMax[parts]![j]!) {
                bestMax[parts]![j] = v;
                cutAt[parts]![j] = i;
              }
            }
          }
        }
        if (bestMax[k]![n]! > budget) return fill(budget);
        const chunks: string[][] = [];
        for (let parts = k, j = n; parts >= 1; parts--) {
          const i = cutAt[parts]![j]!;
          chunks.unshift(col.slice(i, j));
          j = i;
        }
        return chunks;
      };
      const BALANCE_MIN_CELLS = 4;
      // Under a band budget, the lowest column height at which the group's
      // columns fit the band side by side in ONE band wins: shorter columns
      // mean more of them and a group that wraps onto bands anyway, taller
      // ones a group that fills the band's width in one pass (five button
      // blocks as two columns of three beside two columns of test points).
      let chosenH = balanceH;
      if (bandBudgetW !== Infinity || shapeToAspect) {
        const widthAt = (h: number): number => {
          const cols = columns.flatMap((col) => splitColumn(col, h, BALANCE_MIN_CELLS));
          // the same channel and facing-label widening the placement below applies
          return cols.reduce((sum, c, i) => {
            const next = cols[i + 1];
            return sum + Math.max(...c.map((r) => cellDims.get(r)!.w)) + (next ? CHANNEL + widenBy(labelExtents(c).right, labelExtents(next).left, 2 * MARGIN + CHANNEL) : 0);
          }, 0);
        };
        // against the band the columns actually get (the budget less the
        // group's own label reserves), not the raw budget
        const ceiling = Math.max(balanceH, ...columns.map(colH));
        for (let h = balanceH; h <= ceiling; h += 2) {
          if (widthAt(h) <= searchBand) {
            chosenH = h;
            break;
          }
        }
        if (widthAt(chosenH) > searchBand) chosenH = shapeToAspect ? balanceH : ceiling;
      }
      let columnsToPlace: string[][] = columns.flatMap((col) =>
        splitColumn(col, chosenH, BALANCE_MIN_CELLS).flatMap((c) => (sheetBudget === Infinity ? [c] : splitColumn(c, sheetBudget))),
      );
      // Shelf infill. An IC's side shelf is as deep as its tallest lane, but
      // the lanes hang from the top pins and the shelf below them is empty;
      // small cells from later columns move into that room (the USB ESD
      // array under the UART bridge's transistor runs, where the hand-laid
      // sheet keeps it), and the column they leave narrows or disappears.
      const infill = new Map<string, { key: string; side: -1 | 1; relY: number }[]>();
      for (let ci = 0; ci < columnsToPlace.length; ci++) {
        for (const host of columnsToPlace[ci]!) {
          const d = cellDims.get(host)!;
          for (const side of [1, -1] as const) {
            const shelf = side === 1 ? d.shelfR : d.shelfL;
            const used = side === 1 ? d.usedR : d.usedL;
            const reach = side === 1 ? d.reachR ?? 0 : d.reachL ?? 0;
            if (!shelf || used === undefined) continue;
            const freeW = shelf - reach - 1;
            let top = d.topPad + VMARGIN + used;
            let freeH = d.h - top - 1;
            trace(`infill room: ${instByKey.get(host)!.ref} ${side === 1 ? 'right' : 'left'} shelf ${shelf}u reach ${reach}u used ${used}u -> free ${freeW}x${freeH}u`);
            if (freeW < 8 || freeH < 8) continue;
            // candidates from every other column, later ones first; a cell
            // leaving the host's own column shortens it
            const order = [...columnsToPlace.keys()].sort((a, b) => (a > ci ? 0 : a === ci ? 1 : 2) - (b > ci ? 0 : b === ci ? 1 : 2) || a - b);
            for (const cj of order) {
              if (freeH < 8) break;
              const col = columnsToPlace[cj]!;
              for (let k = col.length - 1; k >= 0 && freeH >= 8; k--) {
                const cand = col[k]!;
                if (cand === host) continue;
                // connectors keep the left column (the reader looks for them
                // there); anchors and anything with lanes of its own stay put
                // only a substantial part (four pins or more: an ESD array, a
                // level shifter) is worth tucking away; scattering test points
                // and LEDs into shelves reads as clutter, not economy
                const cinst = instByKey.get(cand)!;
                if (isConnector(cinst.part) || cinst.sym.pins.length < 4) continue;
                const cd = cellDims.get(cand)!;
                if (cd.shelfL || cd.shelfR || cd.w > freeW || cd.h > freeH) continue;
                infill.set(host, [...(infill.get(host) ?? []), { key: cand, side, relY: top }]);
                col.splice(k, 1);
                trace(`infill: ${instByKey.get(cand)!.ref} moves under the ${side === 1 ? 'right' : 'left'} shelf of ${instByKey.get(host)!.ref}`);
                top += cd.h + ROW_GAP;
                freeH -= cd.h + ROW_GAP;
              }
            }
          }
        }
      }
      columnsToPlace = columnsToPlace.filter((c) => c.length);
      const hostGeom = new Map<string, { colX: number; colW: number; colShelfR: number; rowY: number }>();
      trace(`group "${gname}" columns (band ${bandBudgetW === Infinity ? 'inf' : bandBudgetW}u, col budget ${colBudgetH === Infinity ? 'inf' : colBudgetH}u, balance ${balanceH}u chosen ${chosenH}u): ${columnsToPlace.map((c) => `[${c.map((k) => `${instByKey.get(k)!.ref}:${cellDims.get(k)!.w}x${cellDims.get(k)!.h}`).join(' ')}]`).join(' ')}`);
      let colX = groupX;
      let groupMaxY = 0;
      let bandTop = 0; // y origin (units) of the current band of columns
      let bandCount = 1;
      for (let ci = 0; ci < columnsToPlace.length; ci++) {
        const col = columnsToPlace[ci]!;
        const colW = Math.max(...col.map((r) => cellDims.get(r)!.w));
        const colShelfL = Math.max(...col.map((r) => cellDims.get(r)!.shelfL));
        const colShelfR = Math.max(...col.map((r) => cellDims.get(r)!.shelfR));
        const colCoreW = Math.max(...col.map((r) => cellDims.get(r)!.w - cellDims.get(r)!.shelfL - cellDims.get(r)!.shelfR));
        // Banding (#219): a column that would tile past the width budget starts
        // a new band of columns below everything placed so far, the way the
        // shelf-wrap below re-rows whole groups. Never before the first column
        // of a band, so a single over-wide column still places (and the caller
        // rejects this budget instead).
        if (colX > groupX && colX + colW - groupX > bandW) {
          bandTop = groupMaxY + GROUP_GAP;
          colX = groupX;
          bandCount++;
        }
        let rowY = bandTop;
        for (const ref of col) {
          const dims = cellDims.get(ref)!;
          // shared column axis (units): the core span between the shelves a
          // hung IC reserves beside itself
          const cx = colX + colShelfL + Math.floor((colW - colShelfL - colShelfR - Math.max(0, colW - colShelfL - colShelfR - colCoreW)) / 2);
          const b = dims.body;
          // the body sits at the top of its cell, under the room any up-hang
          // needs; a cell with nothing hung is body plus margins, so this is
          // its centre as before
          const cy = rowY + dims.topPad + VMARGIN + Math.floor(ceilU(b.maxY - b.minY) / 2);
          // origin so the body centers on the cell center, snapped to grid
          const ox = grid(cx - Math.round((b.minX + b.maxX) / 2 / U));
          const oy = grid(cy + Math.round((b.minY + b.maxY) / 2 / U));
          const inst = instByKey.get(ref)!;
          placed.set(ref, {
            part: inst.part,
            refDes: inst.ref,
            unit: inst.unit,
            sym: inst.sym,
            x: ox,
            y: oy,
            body: { minX: ox + b.minX, minY: oy - b.maxY, maxX: ox + b.maxX, maxY: oy - b.minY },
            cellW: dims.w,
            cellH: dims.h,
            rot: 0,
          });
          if (infill.has(ref)) hostGeom.set(ref, { colX, colW, colShelfR, rowY });
          rowY += dims.h + ROW_GAP;
        }
        groupMaxY = Math.max(groupMaxY, rowY - ROW_GAP);
        const next = columnsToPlace[ci + 1];
        colX += colW + CHANNEL + (next ? widenBy(labelExtents(col).right, labelExtents(next).left, 2 * MARGIN + CHANNEL) : 0);
      }

      // decoupling rows: caps in a uniform row under their owner (or the group)
      // by rail first, then by reference: caps of one rail sit side by side
      // and share one trunk and one pair of symbols (sorted by reference
      // alone, a +5V cap numbered after the +3V3 caps stood apart with its
      // own two symbols)
      const railOf = (key: string): string => {
        const inst = instByKey.get(key)!;
        for (const p of inst.sym.pins) {
          const n = netByEndpoint.get(`${inst.ref}.${p.number}`);
          if (n && (netClasses.get(n.name)?.cls ?? 'signal') === 'rail') return n.name;
        }
        return '';
      };
      const capRefs = caps.map((c) => c.key).sort((a, b) => railOf(a).localeCompare(railOf(b)) || a.localeCompare(b, undefined, { numeric: true }));
      if (capRefs.length) {
        // The bank stacks under the circuit at the circuit's own width, the
        // way a hand-drawn sheet does — a 45-cap ribbon run out to the band
        // budget alone turned the group into an L-shape wider than the sheet
        // it deserved (#233). The floor keeps a short bank (four typical cap
        // cells) on one row even when the circuit above it is narrower.
        const blockW = Math.max(64, colX - groupX);
        let capBudget = Math.min(bandW, blockW);
        // Under a height budget the bank is part of the group's height too:
        // when its rows at the circuit's width would run past the budget,
        // widen the bank — only as far as the rows need, never past the
        // band — instead of letting it decide the sheet on its own.
        if (colBudgetH !== Infinity) {
          const capWidths = capRefs.map((ref) => {
            const b = bodyBoundsOf(instByKey.get(ref)!.sym);
            return ceilU(b.maxX - b.minX) + 2 * MARGIN;
          });
          const rowsAt = (budget: number): number => {
            let rows = 1;
            let x = 0;
            for (const w of capWidths) {
              if (x > 0 && x + w > budget) {
                rows++;
                x = 0;
              }
              x += w;
            }
            return rows;
          };
          const rowsAllowed = Math.max(1, Math.floor((colBudgetH - groupMaxY - (MARGIN + 4)) / (2 * MARGIN + 6)));
          if (rowsAt(capBudget) > rowsAllowed) {
            const total = capWidths.reduce((a, b) => a + b, 0);
            capBudget = Math.min(bandW, Math.max(capBudget, Math.ceil(total / rowsAllowed) + Math.max(...capWidths)));
          }
        }
        let capX = groupX;
        let capY = groupMaxY + MARGIN + 4;
        let bankRowH = 2 * MARGIN + 6;
        for (const ref of capRefs) {
          const inst = instByKey.get(ref)!;
          // A bank member with horizontal leads (a TVS diode drawn lying down)
          // stands up like the caps beside it, its rail lead on top; lying in
          // the row it carried its ground symbol sideways under the next
          // cap's name.
          let rot = 0;
          if (inst.sym.pins.length === 2 && inst.sym.pins.every((p) => outward(p).dx !== 0)) {
            const railPin = inst.sym.pins.find((p) => (netClasses.get(netByEndpoint.get(`${inst.ref}.${p.number}`)?.name ?? '')?.cls ?? 'signal') === 'rail') ?? inst.sym.pins[0]!;
            rot = orientFor(ref, railPin.number, { dx: 0, dy: -1 }) ?? 90;
          }
          const sym = rotatedSym(inst.sym, rot);
          const b = bodyBoundsOf(sym);
          // a measured cap takes the room its drawing needed (its own fields,
          // the rail bar and name above, the ground below), plus the pad
          const mo = measured?.get(ref);
          const capW = mo ? ceilU(mo.left) + ceilU(b.maxX - b.minX) + ceilU(mo.right) + 2 * MEASURE_PAD : ceilU(b.maxX - b.minX) + 2 * MARGIN;
          const capLeft = mo ? ceilU(mo.left) + MEASURE_PAD : MARGIN;
          const capTop = mo ? ceilU(mo.top) + MEASURE_PAD : MARGIN;
          const capRowH = mo ? capTop + ceilU(b.maxY - b.minY) + ceilU(mo.bottom) + MEASURE_PAD : 2 * MARGIN + 6;
          bankRowH = Math.max(bankRowH, capRowH);
          // Banding (#219): a decoupling bank wider than the budget wraps onto
          // another uniform row rather than running past the frame; and it
          // wraps BEFORE a rail whose caps would not all fit the row, so one
          // rail's caps stay on one trunk (PVDD's pair split across two rows
          // left the second cap with its own two symbols).
          const railStart = capRefs.indexOf(ref) === 0 || railOf(capRefs[capRefs.indexOf(ref) - 1]!) !== railOf(ref);
          let railRunW = 0;
          if (railStart) {
            for (let k = capRefs.indexOf(ref); k < capRefs.length && railOf(capRefs[k]!) === railOf(ref); k++) {
              const kb = bodyBoundsOf(rotatedSym(instByKey.get(capRefs[k]!)!.sym, rot));
              const km = measured?.get(capRefs[k]!);
              railRunW += km ? ceilU(km.left) + ceilU(kb.maxX - kb.minX) + ceilU(km.right) + 2 * MEASURE_PAD : ceilU(kb.maxX - kb.minX) + 2 * MARGIN;
            }
          }
          const needW = railStart && railRunW <= capBudget ? railRunW : capW;
          if (capX > groupX && capX + needW - groupX > capBudget) {
            capX = groupX;
            capY += bankRowH;
            bankRowH = capRowH;
          }
          const ox = mo ? grid(capX + capLeft - Math.floor(b.minX / U)) : grid(capX + MARGIN);
          const oy = mo ? grid(capY + capTop + Math.ceil(b.maxY / U)) : grid(capY + MARGIN);
          placed.set(ref, {
            part: inst.part,
            refDes: inst.ref,
            unit: inst.unit,
            sym,
            x: ox,
            y: oy,
            body: { minX: ox + b.minX, minY: oy - b.maxY, maxX: ox + b.maxX, maxY: oy - b.minY },
            cellW: capW,
            cellH: capRowH,
            rot,
          });
          capX += capW;
        }
        groupMaxY = capY + bankRowH;
      }

      // ---------- idiom micro-templates and the alignment pass (7.5/7.5a) ----------
      // Column placement is correct but reads machine-made for the small
      // structures a human drafter draws by reflex: a pull-up sits directly on
      // the pin it pulls with its rail above, a series RC hangs as one straight
      // vertical run, crystal load caps mirror about their crystal. Two passes
      // rearrange exactly those shapes after column placement, both no-ops
      // unless the textbook topology is present, and both collision-checked so
      // a failed fit falls back to the column position rather than overlapping.
      const inGroup = new Set(members.map((m) => m.key));
      const idiomPlaced = new Set<string>();
      const CHAIN_GAP = 4 * U;
      /** The two pins of a vertically-pinned two-lead instance, or null. */
      const vertPins = (key: string): { top: DraftPin; bot: DraftPin } | null => {
        const pins = placed.get(key)?.sym.pins ?? [];
        if (pins.length !== 2) return null;
        const top = pins.find((p) => outward(p).dy === -1);
        const bot = pins.find((p) => outward(p).dy === 1);
        return top && bot ? { top, bot } : null;
      };
      const isCrystal = (key: string): boolean => /crystal|reson/i.test(placed.get(key)?.part.libId ?? '');
      /** An instance the chain pass may move: two vertical leads, in this group,
       * not already spoken for by the decap row or the crystal template. */
      const chainable = (key: string): boolean =>
        inGroup.has(key) && !decapOwner.has(key) && !idiomPlaced.has(key) && !isCrystal(key) && vertPins(key) !== null;
      /** Endpoint REF.PIN for an instance's pin (the base refdes, never the key). */
      const epOf = (key: string, pin: string): string => `${placed.get(key)?.refDes ?? key}.${pin}`;
      const parseEp = (ep: string): { ref: string; pin: string; key: string } | null => {
        const m = /^([^.]+)\.(.+)$/.exec(ep);
        return m ? { ref: m[1]!, pin: m[2]!, key: instKeyOf(m[1]!, m[2]!) } : null;
      };
      const classOf = (name: string): NetClass => netClasses.get(name)?.cls ?? 'signal';
      const padOverlap = (a: Bounds, b: Bounds, pad: number): boolean =>
        a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minY < b.maxY + pad && a.maxY > b.minY - pad;
      /** Candidate placement putting `key`'s TOP pin connection point at (x, y). */
      const candidateAt = (key: string, x: number, y: number): Placed => {
        const prev = placed.get(key)!;
        const v = vertPins(key)!;
        const b = bodyBoundsOf(prev.sym);
        const ox = x - v.top.x;
        const oy = y + v.top.y;
        return {
          part: prev.part,
          refDes: prev.refDes,
          unit: prev.unit,
          sym: prev.sym,
          x: ox,
          y: oy,
          body: { minX: ox + b.minX, minY: oy - b.maxY, maxX: ox + b.maxX, maxY: oy - b.minY },
          cellW: prev.cellW,
          cellH: prev.cellH,
          rot: prev.rot,
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
      const ownEndpoints = (keys: Iterable<string>): Set<string> => {
        const eps = new Set<string>();
        for (const key of keys) {
          for (const pin of placed.get(key)?.sym.pins ?? []) {
            const net = netByEndpoint.get(epOf(key, pin.number));
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
            const ep = `${opl.refDes}.${pin.number}`;
            const net = netByEndpoint.get(ep);
            if (!net) continue;
            const o = outward(pin);
            const len = classOf(net.name) !== 'signal' && o.dx !== 0 ? STUB + 2 : STUB;
            const p = pinAt(opl, pin);
            const end = { x: p.x + o.dx * len * U, y: p.y + o.dy * len * U };
            if (!ownEps.has(ep)) {
              for (const q of [p, end]) {
                if (sameCoord(q.x, axisX) && q.y > yMin - U && q.y < yMax + U) {
                  trace(`axis x=${axisX} blocked by ${ep} (${net.name}) at y=${q.y}`);
                  return false;
                }
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
                if (axisX >= lo && axisX <= hi) {
                  trace(`axis x=${axisX} crossed by the stub of ${ep} (${net.name}) on a ${row.net} row`);
                  return false;
                }
              }
            }
          }
        }
        return true;
      };
      /** The room a rail/ground end grows past its pin: stub, bar, value text. */
      const POWER_CLEAR = 5 * U;
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
        ownOverride?: Set<string>,
      ): boolean => {
        const own = ownOverride ?? ownEndpoints(moves.keys());
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
            if (padOverlap(box, op.body, 0)) {
              trace(`power end at x=${(box.minX + box.maxX) / 2} would sit on ${oref}`);
              return false;
            }
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
        if (!isCrystal(m.key)) continue;
        const xpl = placed.get(m.key);
        if (!xpl || xpl.sym.pins.length !== 2) continue;
        const moves = new Map<string, Placed>();
        const segments: { axisX: number; ys: number[] }[] = [];
        const clearBoxes: Bounds[] = [];
        for (const pin of xpl.sym.pins) {
          const o = outward(pin);
          if (o.dx === 0) continue;
          const net = netByEndpoint.get(`${m.ref}.${pin.number}`);
          if (!net || classOf(net.name) !== 'signal') continue;
          const cap = net.pins
            .map(parseEp)
            .find((e): e is { ref: string; pin: string; key: string } => {
              if (!e || e.key === m.key || !chainable(e.key) || moves.has(e.key)) return false;
              const v = vertPins(e.key)!;
              if (e.pin !== v.top.number) return false; // crystal node must enter the cap's top lead
              const other = netByEndpoint.get(`${e.ref}.${v.bot.number}`);
              return other !== undefined && classOf(other.name) !== 'signal';
            });
          if (!cap) continue;
          const at = pinAt(xpl, pin);
          const axisX = at.x + o.dx * STUB * U;
          const cand = candidateAt(cap.key, axisX, at.y + CHAIN_GAP);
          const v = vertPins(cap.key)!;
          moves.set(cap.key, cand);
          segments.push({ axisX, ys: [at.y, cand.y - v.bot.y] });
          clearBoxes.push(powerEndBox(axisX, cand.y - v.bot.y, 1)); // the ground symbol below the cap
        }
        // all-or-nothing per crystal: one dropped cap and one column cap would
        // read worse than the plain columns the pass is improving on
        if (moves.size) finalizeMoves(segments, moves, clearBoxes);
      }

      // Pin-anchored hangs claimed above: each chain drops from its pin's row
      // into its shelf slot. Slot 0 sits past the IC's labels on that side,
      // so the wire pass draws pin, stub, a short branch and the chain's
      // stub as one local route; deeper slots stagger outward. A hang the
      // clearance check refuses goes to the leftover column at the group's
      // right edge, never on top of something.
      const leftovers: string[] = [];
      const placeInfill = (): void => {
        for (const [host, cells] of infill) {
          const g = hostGeom.get(host);
          const d = cellDims.get(host)!;
          if (!g) continue;
          for (const f of cells) {
            const cd = cellDims.get(f.key)!;
            const fb = cd.body;
            const x0 = f.side === 1 ? g.colX + g.colW - g.colShelfR + (d.reachR ?? 0) : g.colX + 1;
            const fcx = x0 + Math.floor(cd.w / 2);
            const fcy = g.rowY + f.relY + Math.floor(cd.h / 2);
            const fox = grid(fcx - Math.round((fb.minX + fb.maxX) / 2 / U));
            const foy = grid(fcy + Math.round((fb.minY + fb.maxY) / 2 / U));
            placed.set(f.key, placeCell(f.key, fox, foy));
          }
        }
      };
      const placeCell = (key: string, ox: number, oy: number, rot = 0, mirror?: 'y'): Placed => {
        const inst = instByKey.get(key)!;
        const dims = cellDims.get(key)!;
        const sym = transformSym(inst.sym, rot, mirror);
        const b = bodyBoundsOf(sym);
        return {
          part: inst.part,
          refDes: inst.ref,
          unit: inst.unit,
          sym,
          x: ox,
          y: oy,
          body: { minX: ox + b.minX, minY: oy - b.maxY, maxX: ox + b.maxX, maxY: oy - b.minY },
          cellW: dims.w,
          cellH: dims.h,
          rot,
          ...(mirror ? { mirror } : {}),
        };
      };
      placeInfill();
      // Inline runs: each part lies on its pin's row with its near lead
      // toward the IC, one gap past the stub, the next part one gap on. The
      // wire pass then draws pin, stub, gap and lead as one straight line.
      for (const il of inlines) {
        const icPl = placed.get(il.ic);
        if (!icPl) {
          leftovers.push(...il.chain.map((c) => c.key));
          continue;
        }
        const at = pinAt(icPl, il.pin);
        const s = { x: at.x + il.dx * STUB * U, y: at.y };
        const moves = new Map<string, Placed>();
        let cursor = s.x + il.dx * il.offset; // x of the last connection point on the row
        let ok = true;
        for (const c of il.chain) {
          const ctl = controlPinOf(c.key);
          // a transistor keeps collector up and emitter down; it is mirrored,
          // never turned, so its base faces the part that drives it
          const mirror: 'y' | undefined = ctl ? (outward(ctl).dx === -il.dx ? undefined : 'y') : undefined;
          const rot = ctl ? 0 : orientFor(c.key, c.nearPin, { dx: -il.dx, dy: 0 });
          if (rot === null) {
            ok = false;
            break;
          }
          cursor = cursor + il.dx * c.gap; // the next near lead
          const rs = transformSym(instByKey.get(c.key)!.sym, rot, mirror);
          const near = rs.pins.find((pn) => pn.number === c.nearPin)!;
          const ox = grid(Math.round((cursor - near.x) / U));
          const oy = grid(Math.round((s.y + near.y) / U));
          moves.set(c.key, placeCell(c.key, ox, oy, rot, mirror));
          cursor = cursor + il.dx * spanOf(c.key);
        }
        if (ok) {
          for (const [key, cand] of moves) placed.set(key, cand);
          // no axis to clear: the run's wires are the row itself, which the
          // wire pass checks segment by segment; bodies must still fit
          if (!finalizeMoves([], moves, [], new Set())) {
            for (const key of moves.keys()) placed.delete(key);
            ok = false;
          }
        }
        if (!ok) {
          leftovers.push(...il.chain.map((c) => c.key));
          for (const c of il.chain) boundTo.delete(c.key);
          const refs = il.chain.map((c) => instByKey.get(c.key)!.ref).join(', ');
          const note = `inline refused: ${refs} could not lie on ${instByKey.get(il.ic)!.ref}.${il.pin.number}'s row in "${gname}"; drawn in a column instead`;
          trace(note);
          if (!notes.includes(note)) notes.push(note);
        }
      }
      for (const hg of hangs) {
        const icPl = placed.get(hg.ic);
        if (!icPl) {
          leftovers.push(...hg.chain);
          continue;
        }
        // a node anchor is a hung part, placed turned: read its pin as drawn
        const pinNow = icPl.sym.pins.find((p) => p.number === hg.pin.number) ?? hg.pin;
        const at = pinAt(icPl, pinNow);
        const s = { x: at.x + hg.dx * STUB * U, y: at.y };
        const side = hangs.filter((o) => o.ic === hg.ic && o.dx === hg.dx);
        const pitch = Math.max(0, ...side.map((o) => o.w)) + U;
        const ext = labelExtents([hg.ic]);
        const reach = sideReach(hg.ic, hg.dx);
        void ext;
        const firstSlot = grid(Math.round((s.x + hg.dx * (reach + 2 * U + pitch / 2)) / U));
        const slotX = grid(Math.round((firstSlot + hg.dx * hg.slot * pitch) / U));
        trace(`hang ${hg.chain.map((k) => instByKey.get(k)!.ref).join('+')} on ${instByKey.get(hg.ic)!.ref}.${hg.pin.number}: stub (${s.x}, ${s.y}) reach ${reach.toFixed(2)} pitch ${pitch.toFixed(2)} slot ${hg.slot} -> x ${hg.straight ? s.x : slotX}${hg.straight ? ' (straight)' : ''}`);
        const netOfHang = (key: string, pinN: string): string => netByEndpoint.get(`${instByKey.get(key)!.ref}.${pinN}`)?.name ?? '';
        let placedOk = false;
        // dead straight on the stub axis when the pin-neighbour test found
        // the rows free (AC-16.31), else the reserved shelf slot. Trying the
        // axis regardless passed the clearance check — a wire may legally
        // cross a neighbouring rail stub — and drew exactly that crossing
        // on the Tier C divider, twice.
        const axes = hg.straight ? [s.x] : [slotX];
        // Chains on one side start level: drops below the side's lowest hung
        // pin row, rises above its highest. Started at its own row, a chain
        // from one pin put its body across the next pin's row, and that
        // pin's run out to its lane hit the body (U1's FLT pull-up against
        // the OVLO divider). Level bases turn that into a wire crossing at
        // worst, and the resistors of a comb line up the way a drafter
        // lines them up. A straight hang keeps its own row.
        const sidePinYsAbs = side.map((o) => pinAt(icPl, icPl.sym.pins.find((p) => p.number === o.pin.number) ?? o.pin).y);
        const baseY = hg.straight ? s.y : hg.dir === 1 ? Math.max(...sidePinYsAbs) : Math.min(...sidePinYsAbs);
        for (const axisX of axes) {
        for (let lift = 0; lift < 3 && !placedOk; lift++) {
          // the near lead of the first part sits one gap from the base row,
          // and each further part one gap on, away from the IC
          let cursor = grid(Math.round((baseY + hg.dir * HANG_GAP) / U)) + hg.dir * lift * 2 * U;
          const moves = new Map<string, Placed>();
          const conn: { y: number; net: string }[] = [{ y: s.y, net: netOfHang(hg.ic, hg.pin.number) }];
          const startY = cursor;
          const nearPins = hangNearPins.get(hg.chain.join('+'))!;
          for (const [i, key] of hg.chain.entries()) {
            // turned so the near lead faces the row (up for a hang that
            // drops, down for one that rises) and the far lead points away
            const rot = orientFor(key, nearPins[i]!, { dx: 0, dy: -hg.dir }) ?? 0;
            const rs = rotatedSym(instByKey.get(key)!.sym, rot);
            const near = rs.pins.find((pn) => pn.number === nearPins[i])!;
            const farLead = rs.pins.find((pn) => pn.number !== nearPins[i]) ?? near;
            const span = spanOf(key, rot);
            moves.set(key, placeCell(key, axisX - near.x, cursor + near.y, rot));
            conn.push({ y: cursor, net: netOfHang(key, near.number) }, { y: cursor + hg.dir * span, net: netOfHang(key, farLead.number) });
            cursor = cursor + hg.dir * (span + HANG_GAP);
          }
          const endY = cursor - hg.dir * HANG_GAP;
          const clearBoxes: Bounds[] = hg.ends === 'power' ? [powerEndBox(axisX, endY, hg.dir)] : [];
          const ys = [Math.min(startY, endY, s.y), Math.max(startY, endY, s.y)];
          // Only the nets that run ALONG the axis are the chain's own: the
          // anchor net and each link between chain parts. The rail or ground
          // at the far end is not — a pull-up's rail is also the IC's supply
          // pin, and counting it as own let an axis run straight through
          // that pin (esp32-amp's BUCK_EN divider on U4's PVDD pin; the
          // router refused the wire, so the net shipped labelled).
          const axisNets = new Set(conn.map((c) => c.net));
          const own = new Set<string>();
          for (const net of intent.nets) if (axisNets.has(net.name)) for (const ep of net.pins) own.add(ep);
          // the clearance check reads a chain's OWN connection points from the
          // placed map; hung parts have no column position, so they go in as
          // their candidates first and come out again if the check refuses
          for (const [key, cand] of moves) placed.set(key, cand);
          if (finalizeMoves([{ axisX, ys, conn }], moves, clearBoxes, own)) placedOk = true;
          else for (const key of moves.keys()) placed.delete(key);
        }
        if (placedOk) break;
        }
        if (!placedOk) {
          leftovers.push(...hg.chain);
          for (const k of hg.chain) boundTo.delete(k);
          const refs = hg.chain.map((k) => instByKey.get(k)!.ref).join(', ');
          const note = `hang refused: ${refs} could not be placed cleanly on ${instByKey.get(hg.ic)!.ref}.${hg.pin.number} in "${gname}"; drawn in a column instead`;
          trace(note);
          if (!notes.includes(note)) notes.push(note);
        }
      }
      if (leftovers.length) {
        // a column of their own past everything the group placed so far
        let x = Math.max(groupX, ...[...placed.values()].filter((p) => groupOf.get([...placed.entries()].find(([, q]) => q === p)?.[0] ?? '') === gname).map((p) => Math.ceil(p.body.maxX / U) + MARGIN)) + CHANNEL;
        const colW = Math.max(...leftovers.map((k) => cellDims.get(k)!.w));
        let rowY = bandTop;
        for (const key of leftovers) {
          const dims = cellDims.get(key)!;
          const b = dims.body;
          const cx = x + Math.floor(colW / 2);
          const cy = rowY + Math.floor(dims.h / 2);
          const ox = grid(cx - Math.round((b.minX + b.maxX) / 2 / U));
          const oy = grid(cy + Math.round((b.minY + b.maxY) / 2 / U));
          placed.set(key, placeCell(key, ox, oy));
          rowY += dims.h + ROW_GAP;
        }
        groupMaxY = Math.max(groupMaxY, rowY - ROW_GAP);
        colX = x + colW + CHANNEL;
        void colX;
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
          const net = netByEndpoint.get(epOf(current, pinN));
          if (!net) return { kind: 'open' }; // declared no-connect or unused
          if (classOf(net.name) !== 'signal') return { kind: 'power' };
          // a tapped node is not a series link, but it is a fine END: the chain
          // stops there and the label that names the node sits on it (R18 over
          // Q1's drain, its other end on the four-way USB_EN)
          if (net.pins.length !== 2) return { kind: 'open' };
          const otherEp = net.pins.map(parseEp).find((e) => e !== null && e.key !== current);
          if (!otherEp) return { kind: 'invalid' };
          const opl = placed.get(otherEp.key);
          if (!opl) return { kind: 'invalid' };
          // the other end lives in another group: this end is open, and the
          // label that names the net across the sheet sits on it (an LED's
          // resistor driven from the MCU group stacks over its LED here)
          if (groupOf.get(otherEp.key) !== gname) return { kind: 'open' };
          if (chainable(otherEp.key) && !chain.includes(otherEp.key)) {
            const ov = vertPins(otherEp.key)!;
            // the link must enter through the lead facing the chain, or the
            // drawn run would have to cross the part's own body
            if (otherEp.pin !== (dir === 'up' ? ov.bot.number : ov.top.number)) return { kind: 'invalid' };
            if (dir === 'up') chain.unshift(otherEp.key);
            else chain.push(otherEp.key);
            current = otherEp.key;
            continue;
          }
          const pin = opl.sym.pins.find((p) => p.number === otherEp.pin);
          if (!pin || chain.includes(otherEp.key)) return { kind: 'invalid' };
          return { kind: 'anchor', ref: otherEp.key, pin };
        }
      };
      const chained = new Set<string>();
      for (const m of members) {
        if (!chainable(m.key) || chained.has(m.key)) continue;
        const chain = [m.key];
        let topEnd = walk(m.key, 'up', chain);
        let bottomEnd = walk(chain[chain.length - 1]!, 'down', chain);
        for (const ref of chain) chained.add(ref);
        trace(`chain ${chain.map((k) => instByKey.get(k)!.ref).join('+')}: top ${topEnd.kind} bottom ${bottomEnd.kind}`);
        if (topEnd.kind === 'invalid' || bottomEnd.kind === 'invalid') continue;
        // The anchor sits BELOW the chain but meets its top lead (R18's pin 1
        // on Q1's drain, which faces up): turn every part half a turn so the
        // lead that meets the anchor is the bottom one, and stack upward.
        // The reverse case (an anchor above, met by a bottom lead) mirrors it.
        const flip = (): void => {
          for (const key of chain) {
            const pl = placed.get(key)!;
            placed.set(key, placeCell(key, pl.x, pl.y, (pl.rot + 180) % 360));
          }
          [topEnd, bottomEnd] = [bottomEnd, topEnd];
          chain.reverse();
        };
        if (topEnd.kind === 'anchor' && outward(topEnd.pin).dy === -1 && bottomEnd.kind !== 'anchor') flip();
        else if (bottomEnd.kind === 'anchor' && outward(bottomEnd.pin).dy === 1 && topEnd.kind !== 'anchor') flip();
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
          const netOf = (key: string, pinN: string): string => netByEndpoint.get(epOf(key, pinN))?.name ?? '';
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
        const netOf2 = (key: string, pinN: string): string => netByEndpoint.get(epOf(key, pinN))?.name ?? '';
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

      const memberRefs = [...members.map((m) => m.key), ...capRefs];
      const cells = memberRefs.map((r) => placed.get(r)!);
      if (cells.length) {
        const minX = Math.min(...cells.map((c) => c.body.minX)) - MARGIN * U;
        // a two-lead part carries its reference and value beside its body;
        // at the group's right edge that text is what the next group must
        // clear (the rails bank's "47uF/10V" ran under the amplifier's box)
        const fieldReach = (c: Placed): number =>
          c.sym.pins.length <= 2 ? Math.max(c.refDes.length, c.part.value.length) * TEXT_RESERVE * LABEL_HEIGHT + 1.27 : 0;
        const maxX = Math.max(...cells.map((c) => c.body.maxX + fieldReach(c))) + MARGIN * U;
        // the top inset holds the caption band (a bold caption at
        // CAPTION_SIZE, inset 2 mm) above the tallest thing a cell can carry
        // over its body: a rail symbol on an upward stub with its value text
        // over it, which with an IC at the top-left corner sat 4.3 mm under
        // the box edge at six units; CAPTION_BAND keeps the caption's
        // bottom edge clear of it
        const minY = Math.min(...cells.map((c) => c.body.minY)) - (MARGIN + CAPTION_BAND) * U;
        const maxY = Math.max(...cells.map((c) => c.body.maxY)) + (MARGIN + 2) * U;
        groupRects.push({ name: gname, x1: minX, y1: minY, x2: maxX, y2: maxY });
        trace(`group "${gname}": rect x ${minX.toFixed(1)}..${maxX.toFixed(1)} y ${minY.toFixed(1)}..${maxY.toFixed(1)} (${cells.length} cells)`);
        groupX = Math.round(maxX / U) + GROUP_GAP;
        prevGroup = gname;
        bandsOf.set(gname, bandCount);
      }
    }
    return bandsOf;
  };

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
  const gap = GROUP_GAP * U + wrapGap;
  const usableW = (p: { w: number }): number => p.w - 2 * FRAME - frameSlack;
  const usableH = (p: { h: number }): number => p.h - 2 * FRAME - TITLE_STRIP - frameSlack;

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
    const leftExtOf = (name: string): number => groupExtents.get(name)?.left ?? 0;
    const rightExtOf = (name: string): number => groupExtents.get(name)?.right ?? 0;
    const deltas: { dx: number; dy: number }[] = [];
    let rowOriginX = originX;
    // Label text on the row's flanks needs budget too: a row filled to the
    // full usable width hangs its leading group's left-facing labels outside
    // the frame, where no later shift can reach them (#220, the shelf-wrap
    // analog of the band budget's reserved extents).
    let rowLeftExt = leftExtOf(groupRects[0]!.name);
    let dyUnits = 0;
    let rowH = 0;
    // Every box in a row shares the row's top. The single-row pass gives the
    // boxes different tops when one reserved room above its IC for a
    // pull-up (esp32-amp's rails box started 16 mm below its neighbours),
    // and a row height measured box by box then misses that offset, so the
    // next row landed on the tall box's bottom. Each box moves to the common
    // top; its height is then its own.
    const topY = Math.min(...groupRects.map((r) => r.y1));
    // Rows are consecutive runs of groups (reading order is kept), but WHICH
    // consecutive runs is chosen to minimise the stack's height, not by
    // filling each row until the next group no longer fits: first-fit paired
    // esp32-amp's two tallest groups with two short ones and stacked five
    // rows where four would do. A group wider than the whole budget still
    // starts its own row; it will overflow, and the caller rejects this paper
    // for it.
    const n = groupRects.length;
    const heightOf = (r: (typeof groupRects)[number]): number => r.y2 - r.y1;
    const runFits = (i: number, j: number): boolean =>
      i === j || groupRects[j]!.x2 - groupRects[i]!.x1 + leftExtOf(groupRects[i]!.name) + rightExtOf(groupRects[j]!.name) <= budgetW;
    const best: number[] = new Array(n + 1).fill(Infinity);
    const cut: number[] = new Array(n + 1).fill(0);
    best[0] = 0;
    for (let j = 1; j <= n; j++) {
      let rowMax = 0;
      for (let i = j; i >= 1; i--) {
        rowMax = Math.max(rowMax, heightOf(groupRects[i - 1]!));
        if (!runFits(i - 1, j - 1)) break;
        const h = best[i - 1]! + rowMax + (i > 1 ? gap : 0);
        if (h < best[j]!) {
          best[j] = h;
          cut[j] = i - 1;
        }
      }
      if (best[j] === Infinity) {
        // no run ending here fits: the group is its own (overflowing) row
        best[j] = best[j - 1]! + heightOf(groupRects[j - 1]!) + (j > 1 ? gap : 0);
        cut[j] = j - 1;
      }
    }
    const starts: number[] = [];
    for (let j = n; j > 0; j = cut[j]!) starts.unshift(cut[j]!);
    const rowStart = new Set(starts);
    if (process.env['COPPERHEAD_DRAFT_TRACE']) {
      const rows: string[] = [];
      for (let k = 0; k < starts.length; k++) {
        const a = starts[k]!;
        const b = k + 1 < starts.length ? starts[k + 1]! : n;
        const members = groupRects.slice(a, b);
        rows.push(`[${members.map((r) => r.name.slice(0, 2).trim()).join('+')} h${Math.max(...members.map(heightOf)).toFixed(0)}]`);
      }
      trace(`wrap at ${budgetW.toFixed(0)}: rows ${rows.join(' ')} -> ${best[n]!.toFixed(0)} tall`);
    }
    for (const [idx, r] of groupRects.entries()) {
      if (idx > 0 && rowStart.has(idx)) {
        dyUnits += Math.ceil((rowH + gap) / U);
        rowOriginX = r.x1;
        rowLeftExt = leftExtOf(r.name);
        rowH = 0;
      }
      const lift = grid(Math.round((topY - r.y1) / U));
      deltas.push({ dx: grid(Math.round((originX - rowOriginX) / U)), dy: dyUnits * U + lift });
      rowH = Math.max(rowH, r.y2 + lift - topY);
    }
    void rowLeftExt;
    const xs = groupRects.flatMap((r, i) => [r.x1 + deltas[i]!.dx, r.x2 + deltas[i]!.dx]);
    const ys = groupRects.flatMap((r, i) => [r.y1 + deltas[i]!.dy, r.y2 + deltas[i]!.dy]);
    return { deltas, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };

  /**
   * The column-major counterpart of `wrapTo`: groups keep their declared
   * order but fill top-to-bottom, then left-to-right, the way a person lays
   * a newspaper page. Consecutive runs form columns no taller than `budgetH`;
   * a column is as wide as its widest group (label extents included) and the
   * breaks are chosen to minimise the total width. Groups of like width stack
   * well this way (the engagement sheet's three 250 mm groups in one column,
   * its three 205 mm groups in the next), which rows of mismatched heights
   * never achieve.
   */
  const wrapColumns = (budgetH: number): { deltas: { dx: number; dy: number }[]; w: number; h: number; kind: 'columns' } => {
    const originX = groupRects[0]!.x1;
    const topY = Math.min(...groupRects.map((r) => r.y1));
    const leftExtOf = (name: string): number => groupExtents.get(name)?.left ?? 0;
    const rightExtOf = (name: string): number => groupExtents.get(name)?.right ?? 0;
    const gap = GROUP_GAP * U + wrapGap;
    const n = groupRects.length;
    const hOf = (r: (typeof groupRects)[number]): number => r.y2 - r.y1;
    const wOf = (r: (typeof groupRects)[number]): number => r.x2 - r.x1 + leftExtOf(r.name) + rightExtOf(r.name);
    const runH = (i: number, j: number): number => {
      let h = 0;
      for (let k = i; k <= j; k++) h += hOf(groupRects[k]!) + (k > i ? gap : 0);
      return h;
    };
    const best: number[] = new Array(n + 1).fill(Infinity);
    const cut: number[] = new Array(n + 1).fill(0);
    best[0] = 0;
    for (let j = 1; j <= n; j++) {
      let colW = 0;
      for (let i = j; i >= 1; i--) {
        colW = Math.max(colW, wOf(groupRects[i - 1]!));
        if (i < j && runH(i - 1, j - 1) > budgetH) break;
        const w = best[i - 1]! + colW + (i > 1 ? gap : 0);
        if (w < best[j]!) {
          best[j] = w;
          cut[j] = i - 1;
        }
      }
    }
    const starts: number[] = [];
    for (let j = n; j > 0; j = cut[j]!) starts.unshift(cut[j]!);
    const deltas: { dx: number; dy: number }[] = [];
    let colOriginUnits = Math.round(originX / U);
    let maxH = 0;
    for (let k = 0; k < starts.length; k++) {
      const a = starts[k]!;
      const b = k + 1 < starts.length ? starts[k + 1]! : n;
      const members = groupRects.slice(a, b);
      const colLeft = Math.max(...members.map((r) => leftExtOf(r.name)));
      let yUnits = Math.round(topY / U);
      for (const r of members) {
        deltas.push({ dx: (colOriginUnits + Math.ceil(colLeft / U)) * U - grid(Math.round(r.x1 / U)), dy: yUnits * U - grid(Math.round(r.y1 / U)) });
        yUnits += Math.ceil(hOf(r) / U) + GROUP_GAP + Math.ceil(wrapGap / U);
      }
      maxH = Math.max(maxH, (yUnits - GROUP_GAP) * U - topY);
      colOriginUnits += Math.ceil(Math.max(...members.map(wOf)) / U) + GROUP_GAP + Math.ceil(wrapGap / U);
    }
    if (process.env['COPPERHEAD_DRAFT_TRACE']) {
      trace(`column wrap at ${budgetH.toFixed(0)}: ${starts.map((a, k) => `[${groupRects.slice(a, k + 1 < starts.length ? starts[k + 1]! : n).map((r) => r.name.slice(0, 2).trim()).join('+')}]`).join(' ')} -> ${best[n]!.toFixed(0)} wide`);
    }
    return { deltas, w: best[n]!, h: maxH, kind: 'columns' };
  };

  type SheetFit = {
    paper: (typeof PAPERS)[number];
    wrap: { deltas: { dx: number; dy: number }[]; w: number; h: number; kind?: 'rows' | 'columns' } | null;
    /** The content runs into the title strip beside the title block (the corner itself stays clear). */
    intoStrip?: boolean;
  };
  /** The title block's width along the bottom edge, as the checker measures it. */
  const TITLE_BLOCK_W = 110;
  /**
   * Does wrapped content of `w` × `h` fit sheet `p`? The title strip is
   * reserved across the whole width by default; content taller than that
   * may still fit when the group boxes that reach into the strip stay clear
   * of the title block's own corner (a person lays the left-hand column down
   * to the frame and keeps the bottom-right for the block).
   */
  const fitsFrame = (p: (typeof PAPERS)[number], w: number, h: number, rects: { x1: number; y1: number; x2: number; y2: number }[]): { ok: boolean; intoStrip: boolean } => {
    if (w > usableW(p)) return { ok: false, intoStrip: false };
    if (h <= usableH(p)) return { ok: true, intoStrip: false };
    if (h > usableH(p) + TITLE_STRIP - 4 * U) return { ok: false, intoStrip: false };
    // final placement: centred in width, top-aligned (the frame plus four units) in height
    const minX = Math.min(...rects.map((r) => r.x1));
    const minY = Math.min(...rects.map((r) => r.y1));
    const x0 = FRAME + Math.max(0, (usableW(p) - w) / 2) - minX;
    const y0 = FRAME + 4 * U - minY;
    const corner = { minX: p.w - FRAME - TITLE_BLOCK_W, minY: p.h - FRAME - TITLE_STRIP, maxX: p.w - FRAME, maxY: p.h - FRAME };
    const clear = rects.every((r) => !(r.x1 + x0 < corner.maxX && r.x2 + x0 > corner.minX && r.y1 + y0 < corner.maxY && r.y2 + y0 > corner.minY));
    return { ok: clear, intoStrip: clear };
  };
  /**
   * Whether the current placement fits sheet `p`, with the group shelf-wrap
   * deltas that make it fit. `wrap` is null when there is nothing to reflow:
   * one group is already its own row, and an intent whose parts are all power
   * symbols has no group rect to measure from at all.
   */
  const fitsOn = (p: (typeof PAPERS)[number]): SheetFit | null => {
    if (groupRects.length > 1) {
      const wrappedRects = (d: { dx: number; dy: number }[]): { x1: number; y1: number; x2: number; y2: number }[] =>
        groupRects.map((r, i) => ({ x1: r.x1 + d[i]!.dx, y1: r.y1 + d[i]!.dy, x2: r.x2 + d[i]!.dx, y2: r.y2 + d[i]!.dy }));
      const w = wrapTo(usableW(p));
      const fw = fitsFrame(p, w.w, w.h, wrappedRects(w.deltas));
      if (fw.ok) return { paper: p, wrap: { ...w, kind: 'rows' }, intoStrip: fw.intoStrip };
      // rows of mismatched heights may miss where columns of like widths fit
      for (const budgetH of [usableH(p), usableH(p) + TITLE_STRIP - 4 * U]) {
        const c = wrapColumns(budgetH);
        const fc = fitsFrame(p, c.w, c.h, wrappedRects(c.deltas));
        if (fc.ok) return { paper: p, wrap: c, intoStrip: fc.intoStrip };
      }
      return null;
    }
    const r = groupRects[0];
    return !r || (r.x2 - r.x1 <= usableW(p) && r.y2 - r.y1 <= usableH(p)) ? { paper: p, wrap: null } : null;
  };
  /** The smallest candidate sheet the current placement fits, or null. */
  const bestFit = (): SheetFit | null => {
    for (const p of candidates) {
      const f = fitsOn(p);
      if (f) return f;
    }
    return null;
  };

  /**
   * Budgeted attempt at one sheet. The width budget alone reshapes a ribbon
   * into bands, but a group of stacked two-pin parts fills the HEIGHT first
   * and leaves the landscape width untouched (stickhub reflowed to 347 mm of
   * A1's 821 usable and still overflowed the bottom). Shorter column budgets
   * spread the same cells into more side-by-side columns, so walk the height
   * fractions until the content matches the sheet's aspect or nothing fits.
   */
  /** Closest miss per sheet a budgeted attempt could not fit, for the notes. */
  const budgetMisses: string[] = [];
  const tryPaperBudgeted = (p: (typeof PAPERS)[number]): { fit: SheetFit; bands: Map<string, number> } | null => {
    let best: { w: number; h: number } | null = null;
    // finer fractions re-row a tall group's columns until the groups are
    // short enough for two or three rows of them to stack on the sheet
    for (const [frac, div] of [1, 0.7, 0.5, 0.4, 0.35, 0.3, 0.25].flatMap((fr) => [1, 2, 2.5, 3].map((d) => [fr, d] as const))) {
      // band budgets of a half and a third of the sheet fold a wide flat
      // group (five button blocks in a row) toward the width of a column
      const b = placeAllGroups(Math.floor(usableW(p) / div / U), Math.floor((usableH(p) * frac) / U));
      const f = fitsOn(p);
      if (groupRects.length > 1) {
        const w = wrapTo(usableW(p));
        trace(`try ${p.name} frac ${frac} div ${div}: wrapped ${w.w.toFixed(0)}x${w.h.toFixed(0)} vs ${usableW(p)}x${usableH(p)}; ${groupRects.map((r) => `${r.name.slice(0, 12)}=${(r.x2 - r.x1).toFixed(0)}x${(r.y2 - r.y1).toFixed(0)}`).join(' ')}`);
      }
      if (f) return { fit: f, bands: b };
      // remember the closest miss so a failed pass can say how far off it was
      if (groupRects.length) {
        const w = groupRects.length > 1 ? wrapTo(usableW(p)) : { w: groupRects[0]!.x2 - groupRects[0]!.x1, h: groupRects[0]!.y2 - groupRects[0]!.y1 };
        const over = Math.max(w.w - usableW(p), w.h - usableH(p));
        if (!best || over < Math.max(best.w - usableW(p), best.h - usableH(p))) best = { w: w.w, h: w.h };
      }
    }
    if (best) budgetMisses.push(`${p.name} ${Math.round(best.w)}×${Math.round(best.h)} mm vs ${usableW(p)}×${usableH(p)} usable`);
    return null;
  };

  let compaction: SchematicDraftReport['sheetFit']['compaction'] = hinted ? 'pinned' : 'not-needed';
  let bands = placeAllGroups(Infinity);
  let fit = bestFit();
  if (!fit) {
    // No sheet holds the natural ribbon even with whole groups wrapped into
    // rows: some group is by itself wider than the widest usable frame (#219
    // drew 94 parts as one strip four sizes past the designer's A3, with 367
    // out-of-frame findings — a sheet that would not plot). Growing the paper
    // cannot fix that, so instead wrap COLUMNS into bands inside the oversized
    // groups, targeting the smallest sheet that fits. Each attempt must fit
    // the sheet whose width it banded to: accepting a narrow banding on a
    // larger sheet would re-create the empty-ribbon failure, rotated 90°.
    for (const p of candidates) {
      const t = tryPaperBudgeted(p);
      if (t) {
        bands = t.bands;
        fit = t.fit;
        compaction = 'banded';
        break;
      }
    }
    if (!fit) {
      compaction = 'overflow';
      const largest = candidates[candidates.length - 1]!;
      bands = placeAllGroups(Math.floor(usableW(largest) / U), Math.floor(usableH(largest) / U));
      fit = { paper: largest, wrap: groupRects.length > 1 ? wrapTo(usableW(largest)) : null };
      notes.push(
        `content does not fit the ${hinted ? 'hinted' : 'largest standard'} sheet (${largest.name}) even with groups and columns wrapped; the drawing will overflow the frame`,
      );
    }
    for (const [g, n] of bands) {
      if (n > 1) notes.push(`group "${g}" was wider than the sheet; its columns wrapped onto ${n} bands`);
    }
  } else if (!hinted && fit.paper !== PAPERS[0]) {
    // ---------- compaction (#220 phase 4) ----------
    // The natural ribbon FITS a sheet, but mostly with air: a 24-part board
    // whose parts stack into one full-height strip "fits" A1 while the person
    // drew the same circuit on A3. When the natural fit uses less than the
    // checker's utilization floor, retry the smaller sheets, smallest first,
    // with both budgets, and take the first that holds the reflowed content.
    // A paper hint pins the sheet and skips this entirely.
    // Utilization by INK, not bounding box: an L-shaped layout (a tall column
    // strip plus a wide bank ribbon) spans a bbox that reads "full" while the
    // sheet is mostly air, and the bbox measure let stickhub sprawl onto A0
    // uncompacted. The sum of placed cell areas is what is actually drawn.
    const inkArea = [...placed.values()].reduce((s, p) => s + p.cellW * p.cellH * U * U, 0);
    const utilOf = (f: SheetFit): number => inkArea / (usableW(f.paper) * usableH(f.paper));
    const naturalUtil = utilOf(fit);
    if (naturalUtil < COMPACT_UTILIZATION) {
      const naturalPaper = fit.paper;
      let compacted: SheetFit | null = null;
      let compactedBands = bands;
      for (const p of candidates) {
        if (p === naturalPaper) break; // only sheets smaller than the natural fit
        const t = tryPaperBudgeted(p);
        if (t) {
          compacted = t.fit;
          compactedBands = t.bands;
          break;
        }
      }
      if (compacted) {
        compaction = 'compacted';
        bands = compactedBands;
        fit = compacted;
        notes.push(
          `sheet compacted: the natural layout fit ${naturalPaper.name} at ${Math.round(naturalUtil * 100)}% utilization; reflowed onto ${fit.paper.name}`,
        );
        for (const [g, n] of bands) {
          if (n > 1) notes.push(`group "${g}" was wider than the sheet; its columns wrapped onto ${n} bands`);
        }
      } else {
        // nothing smaller holds the reflowed content: say so, with how far
        // each sheet missed, then restore the natural placement byte for byte
        compaction = 'failed';
        notes.push(
          `sheet not compacted: the natural layout fits ${naturalPaper.name} at ${Math.round(naturalUtil * 100)}% utilization, but no smaller sheet holds the reflowed content (${budgetMisses.join('; ')})`,
        );
        bands = placeAllGroups(Infinity);
        fit = bestFit()!;
      }
    }
  }
  if (fit.wrap) {
    const wrap = fit.wrap;
    if (wrap.kind === 'columns') {
      const cols = new Set(wrap.deltas.map((d) => d.dx)).size;
      notes.push(`groups wrapped onto ${cols} columns to fit the sheet (declared order runs down each column)`);
    } else {
      const rows = new Set(wrap.deltas.map((d) => d.dy)).size;
      if (rows > 1) notes.push(`groups wrapped onto ${rows} rows to fit the sheet`);
    }
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
  const stubbedLabels: {
    label: number;
    wire: number;
    o: { dx: number; dy: number };
    /** The net's own endpoints, so a clearance check can ignore them (#217). */
    pins: string[];
  }[] = [];
  /**
   * Wired-net labels with every wire point of their run as fallback anchors.
   * `pts` is sorted for anchor preference (topmost-leftmost first) and so says
   * nothing about which point joins which; `segs` keeps the run's segments in
   * emission order, which is what the interior walk must step along.
   */
  const wiredLabels: {
    label: number;
    pts: { x: number; y: number }[];
    segs: Seg[];
  }[] = [];
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
      // a common (unit-0) pin is drawn on every placed instance of its part;
      // every appearance is wired to this same net, so the appearances stay
      // one electrical point and no drawn pin end dangles
      .flatMap((ep) => {
        const m = /^([^.]+)\.(.+)$/.exec(ep)!;
        return expandEp(m[1]!, m[2]!).map((inst) => {
          const pl = placed.get(inst.key);
          const pin = pl?.sym.pins.find((p) => p.number === m[2]);
          if (!pl || !pin) return null;
          return { ref: inst.key, pin, at: pinAt(pl, pin) };
        });
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

  /**
   * True when any of `segs` touches a FOREIGN connection point: a pin, the
   * stub end any connected pin grows (predicted — stubs of nets sorted later
   * are not emitted yet), or an already-emitted wire of another net. KiCad
   * joins wires at coincident endpoints and at an endpoint on a wire's
   * interior, so any such contact merges nets (I22, #204).
   *
   * Used by every pass that decides where a wire may end: the trunk-and-branch
   * veto, the labelled-stub fallback (the cap-to-ground drop placed a cap whose
   * own 2-unit stub ended exactly on the neighbouring power pin's stub interior,
   * so stubs need the check as much as trunks), the power-stub ladder, and the
   * label nudge. Defined here rather than beside the signal pass because the
   * power pass below runs first and needs it too (#217).
   */
  const touchesForeign = (
    segs: { x1: number; y1: number; x2: number; y2: number }[],
    netName: string,
    ownEps: Set<string>,
    opts: { predictStubs?: boolean } = {},
  ): boolean => {
    const predictStubs = opts.predictStubs ?? true;
    for (const opl of placed.values()) {
      for (const pin of opl.sym.pins) {
        const ep = `${opl.refDes}.${pin.number}`;
        const onet = netByEndpoint.get(ep);
        // A pin with NO net is still a connection point: a wire through it
        // joins it in KiCad. jetson-agx-thor-baseboard put an L-route corner
        // exactly on such a pin (J14.46, a single-pin group the intent never
        // names) and shipped a merged net past every gate. Only the pin's
        // POINT is guarded for netless pins; there is no stub to predict.
        if (onet?.name === netName || ownEps.has(ep)) continue;
        const p = pinAt(opl, pin);
        if (segs.some((c) => pointOnSeg(p.x, p.y, c))) return true;
        if (!predictStubs || !onet) continue;
        const o = outward(pin);
        const len = (netClasses.get(onet.name)?.cls ?? 'signal') !== 'signal' && o.dx !== 0 ? STUB + 2 : STUB;
        const end = { x: p.x + o.dx * len * U, y: p.y + o.dy * len * U };
        if (segs.some((c) => pointOnSeg(end.x, end.y, c))) return true;
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
    /** One PWR_FLAG per undriven net, on the net's FIRST endpoint — whether
     * that endpoint drafts as a bank member or a lone symbol. */
    const maybeFlag = (i: number, x: number, y: number): void => {
      if (i !== 0 || hasDriver) return;
      const flag = pwrFlagSource();
      libSymbols.set(flag.libId, flag.sourceText);
      flgSeq++;
      extraSymbols.push({
        ref: `#FLG${String(flgSeq).padStart(2, '0')}`,
        libId: flag.libId,
        value: 'PWR_FLAG',
        footprint: '',
        at: { x, y, rot: 0 },
        refAt: { x, y },
        valueAt: { x, y },
        hideRef: true,
        hideValue: true,
        pinNumbers: ['1'],
      });
      pwrFlags.push(net.name);
    };
    // ---------- rail-bank trunks (#233, #220 phase 3) ----------
    // Decap-row caps adjacent on the same power net chain on ONE trunk: a
    // stub per pin, horizontal joins between consecutive stub ends, a single
    // power symbol and value at the first end. The human's sixteen-cap VBUS
    // bank carries two power symbols; the per-pin idiom drew twenty-six.
    // Every stub and trunk segment must clear foreign points and bodies, and
    // a member that cannot join cleanly splits the run — a bank never buys
    // density with a merged net.
    const consumed = new Set<number>();
    {
      const ownEps = new Set(net.pins);
      // Structural, not name-based: any two-pin part with a vertical pin on
      // this power net banks — real boards carry their caps under embedded,
      // renamed symbols the Device:C test never matches, and a pull-up array
      // on one rail trunk is drawn the same way by hand.
      const cands = eps
        .map((ep, i) => ({ ep, i, o: outward(ep.pin) }))
        .filter((c) => c.o.dy !== 0 && c.o.dx === 0 && (placed.get(c.ep.ref)?.sym.pins.length ?? 0) === 2);
      const byLine = new Map<string, typeof cands>();
      for (const c of cands) {
        const k = `${c.o.dy}|${knum(c.ep.at.y + c.o.dy * STUB * U)}`;
        byLine.set(k, [...(byLine.get(k) ?? []), c]);
      }
      const stubClear = (c: (typeof cands)[number]): boolean => {
        const end = { x: c.ep.at.x, y: c.ep.at.y + c.o.dy * STUB * U };
        return !touchesForeign([{ x1: c.ep.at.x, y1: c.ep.at.y, x2: end.x, y2: end.y }], net.name, ownEps, {
          predictStubs: false,
        });
      };
      /**
       * A trunk may not cross the LINE a foreign stub could grow along. The
       * geometry is `segCrossesStubGrowth` (tested directly); this walks every
       * foreign pin over it at the signal stub's maximum grown length.
       */
      const crossesForeignStubLine = (seg: Seg): boolean => {
        for (const opl of placed.values()) {
          for (const pin of opl.sym.pins) {
            const ep = `${opl.refDes}.${pin.number}`;
            const onet = netByEndpoint.get(ep);
            if (!onet || onet.name === net.name) continue;
            if (segCrossesStubGrowth(seg, pinAt(opl, pin), outward(pin), (STUB + 2) * U, SEG_EPS)) return true;
          }
        }
        return false;
      };
      const emitBank = (run: typeof cands): void => {
        const dy = run[0]!.o.dy;
        const ends = run.map((c) => ({ x: c.ep.at.x, y: c.ep.at.y + dy * STUB * U }));
        run.forEach((c, j) => {
          addWire(net.name, c.ep.at.x, c.ep.at.y, ends[j]!.x, ends[j]!.y);
          consumed.add(c.i);
        });
        for (let j = 1; j < ends.length; j++) {
          addWire(net.name, ends[j - 1]!.x, ends[j - 1]!.y, ends[j]!.x, ends[j]!.y);
        }
        const first = ends[0]!;
        const valueAt = { x: first.x, y: first.y + dy * 3.556 };
        const box = powerValueBox(net.name, valueAt.x, valueAt.y);
        const hideValue = shownPowerValues.some((p) => p.net === net.name && boundsOverlap(p.box, box));
        if (!hideValue) shownPowerValues.push({ net: net.name, box });
        pwrSeq++;
        extraSymbols.push({
          ref: `#PWR${String(pwrSeq).padStart(2, '0')}`,
          libId: src.libId,
          value: net.name,
          footprint: '',
          at: { x: first.x, y: first.y, rot: 0 },
          refAt: { x: first.x, y: first.y },
          valueAt,
          hideRef: true,
          hideValue,
          pinNumbers: ['1'],
        });
        for (const [j, c] of run.entries()) maybeFlag(c.i, ends[j]!.x, ends[j]!.y);
      };
      const joinClear = (prev: (typeof cands)[number], c: (typeof cands)[number]): boolean => {
        const y = c.ep.at.y + c.o.dy * STUB * U;
        const seg = { x1: prev.ep.at.x, y1: y, x2: c.ep.at.x, y2: y };
        return (
          c.ep.at.x - prev.ep.at.x <= BANK_PITCH_MAX * U &&
          !powerBodies.some((b) => segCrossesBody(seg.x1, seg.y1, seg.x2, seg.y2, b)) &&
          !touchesForeign([seg], net.name, ownEps, { predictStubs: true }) &&
          !crossesForeignStubLine(seg)
        );
      };
      for (const line of [...byLine.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v)) {
        line.sort((a, b) => a.ep.at.x - b.ep.at.x);
        for (const run of splitBankRuns(line, stubClear, joinClear)) emitBank(run);
      }
    }
    eps.forEach((ep, i) => {
      if (consumed.has(i)) return;
      const o = outward(ep.pin);
      let len = o.dx !== 0 ? STUB + 2 : STUB;
      // Fair share of the channel: a stub may never cross the MIDLINE to the
      // nearest facing foreign pin on its own line, whatever the text pass
      // wants. Drafting order decides who draws first, and a first-drafted
      // stub that fills the channel leaves the facing pin no clear rung at
      // any length — jetson's text-grown 8-unit stub in a 9-unit channel did
      // exactly that, and the facing GND shipped touching (a refusal).
      let maxLen = Infinity;
      for (const opl of placed.values()) {
        for (const pin of opl.sym.pins) {
          const fep = `${opl.refDes}.${pin.number}`;
          if (netByEndpoint.get(fep)?.name === net.name) continue;
          const p2 = pinAt(opl, pin);
          if (o.dx !== 0 && sameCoord(p2.y, ep.at.y) && Math.sign(p2.x - ep.at.x) === o.dx) {
            maxLen = Math.min(maxLen, Math.max(1, Math.floor(Math.abs(p2.x - ep.at.x) / U / 2)));
          } else if (o.dy !== 0 && sameCoord(p2.x, ep.at.x) && Math.sign(p2.y - ep.at.y) === o.dy) {
            maxLen = Math.min(maxLen, Math.max(1, Math.floor(Math.abs(p2.y - ep.at.y) / U / 2)));
          }
        }
      }
      if (len > maxLen) len = maxLen;
      const at = (l: number): { x: number; y: number } => ({ x: ep.at.x + o.dx * l * U, y: ep.at.y + o.dy * l * U });
      // A vertical stub carries its name beyond the bar, in line. A HORIZONTAL
      // stub used to put the name 3.556 mm above (rails) or below (grounds)
      // the bar: 1.4 pin rows off, so on any IC with pins one row apart the
      // rail name of pin 5 sat on the label of pin 4 (esp32-amp's eFuse,
      // VBUS_FUSED over EFUSE_USB_FLT). The name now continues outward along
      // the row, past the bar, where the row is its own.
      const valueAtOf = (end: { x: number; y: number }): { x: number; y: number } =>
        o.dy !== 0
          ? { x: end.x, y: end.y + o.dy * 3.556 }
          : { x: end.x + o.dx * (Math.max(1, net.name.length) * LABEL_ADVANCE * LABEL_HEIGHT / 2 + 1.905), y: end.y };
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
            if (len + 2 > maxLen) break; // text never buys past the midline
            const extended = at(len + 2);
            if (powerBodies.some((bd) => segCrossesBody(ep.at.x, ep.at.y, extended.x, extended.y, bd))) break;
            len += 2;
          }
        }
      }
      /**
       * The length chosen above answers a typographic question: where does the
       * value text stop colliding. It says nothing about where the stub's
       * ENDPOINT lands, and a power stub that ends on another net's stub is a
       * shorted rail (#217: cm5_minima put a +5V pin 4 units above a GND pin,
       * both stubs grew 2 units toward each other, and they met exactly in the
       * middle — the drawn sheet ties +5V to GND).
       *
       * So the text-driven length is only a preference. Try it first, then
       * lengths either side of it, and take the first whose endpoint touches no
       * foreign connection point. Shorter is in the ladder deliberately: two
       * pins facing each other cannot be separated by growing the stub, only by
       * pulling it back. One unit is the floor — the power symbol still needs
       * somewhere to sit.
       *
       * When nothing clears, keep the preferred length and let the merged-net
       * gate refuse loudly. Shipping a quiet short is the one outcome barred.
       */
      const ownPinEps = new Set(net.pins);
      /**
       * Which bodies a stub of length `l` would cross, by index.
       *
       * A pin sits ON its own part's outline, so EVERY length crosses at least
       * that body, including the preferred one the engine ships today. Treating
       * any crossing as disqualifying would veto the whole ladder (it did, on
       * the first attempt at #217). What matters is that moving the stub does
       * not put it through something the preferred length was already clear of.
       */
      const crossedBy = (l: number): Set<number> => {
        const e = at(l);
        const out = new Set<number>();
        powerBodies.forEach((bd, i) => {
          if (segCrossesBody(ep.at.x, ep.at.y, e.x, e.y, bd)) out.add(i);
        });
        return out;
      };
      const baseCrossed = crossedBy(len);
      const clearsAt = (l: number): boolean => {
        if ([...crossedBy(l)].some((i) => !baseCrossed.has(i))) return false;
        const e = at(l);
        return !touchesForeign([{ x1: ep.at.x, y1: ep.at.y, x2: e.x, y2: e.y }], net.name, ownPinEps, {
          predictStubs: false,
        });
      };
      /**
       * Whether the value text would still be clear at length `l`. The length
       * chosen above already answers this for the preferred length; the ladder
       * has to keep answering it, or a stub moved for electrical reasons drags
       * its rail name into a neighbouring body (it dragged "+3V3" into R1 on
       * the pull-up idiom the first time this ladder was written).
       *
       * Only a preference: a text collision is a legibility cost the report
       * names, while a merged net refuses the draft outright. So a rung that is
       * electrically clear but typographically ugly still beats no rung at all.
       */
      const textClearAt = (l: number): boolean => {
        if (hideValue) return true;
        const v = valueAtOf(at(l));
        const b = powerValueBox(net.name, v.x, v.y);
        if (powerBodies.some((bd) => boundsOverlap(b, bd))) return false;
        return !shownPowerValues.some((p) => p.net !== net.name && boundsOverlap(p.box, b));
      };
      if (!clearsAt(len)) {
        const ladder: number[] = [];
        for (let d = 1; d <= MAX_POWER_STUB_SHIFT; d++) {
          if (len + d <= maxLen) ladder.push(len + d);
          if (len - d >= 1) ladder.push(len - d);
        }
        // Full retreat, beyond the bounded shift: the TEXT-driven growth above
        // can carry `len` so far out that every rung within
        // MAX_POWER_STUB_SHIFT still overlaps the facing pin's stub, and the
        // electrically clear short lengths sit out of reach (jetson's D2
        // shipped a 10-unit VCC_IN stub through the facing net's 4-unit stub
        // and its power symbol that way). Last rungs, so any bounded rung
        // that clears still wins and existing layouts do not move.
        for (let l = Math.min(len, STUB + 2); l >= 1; l--) {
          if (!ladder.includes(l)) ladder.push(l);
        }
        const freed = ladder.find((l) => clearsAt(l) && textClearAt(l)) ?? ladder.find(clearsAt);
        if (freed !== undefined) len = freed;
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
      // the flag's pin sits exactly on the stub END so KiCad's connectivity
      // (which joins at wire endpoints) sees the power_out driver
      maybeFlag(i, stubEnd.x, stubEnd.y);
    });
  }

  // signal nets: local nets wired, everything else labelled at a stub
  const bodies = [...placed.values()].map((p) => p.body);
  let wired = 0;
  let labelled = 0;
  for (const net of [...signalNets].sort((a, b) => a.name.localeCompare(b.name))) {
    const eps = endpointsOf(net);
    if (!eps.length) continue;
    const stubs = eps.map((ep) => {
      const o = outward(ep.pin);
      return { ep, end: { x: ep.at.x + o.dx * STUB * U, y: ep.at.y + o.dy * STUB * U }, o };
    });
    type Stub = { ep: (typeof eps)[number]; end: { x: number; y: number }; o: { dx: number; dy: number } };
    /**
     * Trunk-and-branch route for `subset`: a vertical trunk with horizontal
     * branches, at the first of three deterministic trunk positions (median
     * stub x, right of everything, left of everything) whose every segment
     * clears every body and every foreign connection point (I22, #204). Null
     * when none does — the engine may never trip its own wire-through-symbol
     * gate, and a routed contact would merge nets.
     */
    type RouteSeg = { x1: number; y1: number; x2: number; y2: number };
    type Route = { segs: RouteSeg[]; trunkX: number; trunkY?: number };
    const routeStubs = (subset: Stub[]): Route | null => {
      const xs = subset.map((s) => s.end.x).sort((a, b) => a - b);
      const ys = subset.map((s) => s.end.y);
      const admit = (candidate: RouteSeg[]): boolean => {
        if (candidate.some((c) => bodies.some((b) => segCrossesBody(c.x1, c.y1, c.x2, c.y2, b)))) return false;
        return !touchesForeign(candidate, net.name, new Set(net.pins));
      };
      const found: Route[] = [];
      // A vertical trunk with horizontal branches, at the median stub x,
      // right of everything, left of everything.
      const trunkCandidates = [
        grid(Math.round(xs[Math.floor(xs.length / 2)]! / U)),
        grid(Math.round(xs[xs.length - 1]! / U) + STUB),
        grid(Math.round(xs[0]! / U) - STUB),
      ];
      for (const trunkX of trunkCandidates) {
        const candidate: RouteSeg[] = [];
        for (const s of subset) {
          candidate.push({ x1: s.ep.at.x, y1: s.ep.at.y, x2: s.end.x, y2: s.end.y });
          if (!sameCoord(s.end.x, trunkX)) candidate.push({ x1: s.end.x, y1: s.end.y, x2: trunkX, y2: s.end.y });
        }
        // the trunk is split at every branch meet: coincident wire ENDPOINTS
        // are what both KiCad and the geometric netlister join on
        const meetYs = [...new Map(ys.map((y) => [knum(y), y])).values()].sort((a, b) => a - b);
        for (let i = 1; i < meetYs.length; i++) {
          candidate.push({ x1: trunkX, y1: meetYs[i - 1]!, x2: trunkX, y2: meetYs[i]! });
        }
        if (admit(candidate)) found.push({ segs: candidate, trunkX });
      }
      // A comb: the trunk lies ALONG one endpoint's row — the IC pin's row
      // when the net has one — and every other stub rises or drops to it.
      // This is how a pin with parts hung on it is drawn: the row runs out to
      // the axis, the chain above and the chain below meet it in one T. The
      // vertical trunk alone could not route a pull-up and a pull-down on one
      // pin (its branch to the second part ran along a foreign row), so one
      // of them shipped labelled.
      const rows = [...new Map(subset.map((s) => [knum(s.end.y), s])).values()].sort((a, b) => {
        const ica = (placed.get(a.ep.ref)?.sym.pins.length ?? 0) >= 3 ? 0 : 1;
        const icb = (placed.get(b.ep.ref)?.sym.pins.length ?? 0) >= 3 ? 0 : 1;
        return ica - icb || a.end.y - b.end.y;
      });
      for (const rowStub of rows) {
        const trunkY = rowStub.end.y;
        const candidate: RouteSeg[] = [];
        for (const s of subset) {
          candidate.push({ x1: s.ep.at.x, y1: s.ep.at.y, x2: s.end.x, y2: s.end.y });
          if (!sameCoord(s.end.y, trunkY)) candidate.push({ x1: s.end.x, y1: s.end.y, x2: s.end.x, y2: trunkY });
        }
        const meetXs = [...new Map(xs.map((x) => [knum(x), x])).values()].sort((a, b) => a - b);
        for (let i = 1; i < meetXs.length; i++) {
          candidate.push({ x1: meetXs[i - 1]!, y1: trunkY, x2: meetXs[i]!, y2: trunkY });
        }
        if (admit(candidate)) found.push({ segs: candidate, trunkX: meetXs[0]!, trunkY });
      }
      // A hook, for two stubs where one lies on a row and the other is a
      // lead below or above it on an axis the row would have to cross: run
      // the row past the lead by two units, turn to the lead's level, and
      // come back to its stub end. This is how a bootstrap cap's far lead is
      // reached from the row it bridges to (the other lead sits on the same
      // axis, in the way of a straight drop).
      if (!found.length && subset.length === 2) {
        for (const [a, b] of [[subset[0]!, subset[1]!], [subset[1]!, subset[0]!]] as const) {
          if (a.o.dx === 0 || b.o.dy === 0) continue; // a: a sideways pin (the row); b: a vertical lead
          for (const past of [2 * U, -2 * U]) {
            const turnX = grid(Math.round((b.end.x + past) / U));
            const candidate: RouteSeg[] = [
              { x1: a.ep.at.x, y1: a.ep.at.y, x2: a.end.x, y2: a.end.y },
              { x1: a.end.x, y1: a.end.y, x2: turnX, y2: a.end.y },
              { x1: turnX, y1: a.end.y, x2: turnX, y2: b.end.y },
              { x1: turnX, y1: b.end.y, x2: b.end.x, y2: b.end.y },
              { x1: b.ep.at.x, y1: b.ep.at.y, x2: b.end.x, y2: b.end.y },
            ].filter((c) => !(sameCoord(c.x1, c.x2) && sameCoord(c.y1, c.y2)));
            if (admit(candidate)) {
              found.push({ segs: candidate, trunkX: turnX });
              break;
            }
          }
          if (found.length) break;
        }
      }
      if (!found.length) {
        trace(`route ${net.name}: no clean route for ${subset.map((s) => `${s.ep.ref}.${s.ep.pin.number}`).join(', ')}`);
        return null;
      }
      // the fewest segments is the fewest bends; ties keep the classic order
      return found.reduce((best, r) => (r.segs.length < best.segs.length ? r : best), found[0]!);
    };
    /** Labels naming this net's wired runs, promoted to flags below if the net also leaves through a stub. */
    const netWired: number[] = [];
    /** Draw a routed subset: its wires, one label naming the net, and junction dots. */
    const commitRoute = (subset: Stub[], r: Route): void => {
      for (const c of r.segs) addWire(net.name, c.x1, c.y1, c.x2, c.y2);
      // one label names the wired run (topmost-leftmost wire point): the net
      // stays identifiable to PINOUT/drift and to a reviewer without a
      // label-per-pin, matching hand-drafting practice
      const pts = r.segs.flatMap((c) => [
        { x: c.x1, y: c.y1 },
        { x: c.x2, y: c.y2 },
      ]);
      pts.sort((a, b) => a.y - b.y || a.x - b.x);
      // The name stands above the wire from its anchor rightward. A trunk's
      // top is the classic place; a run that is one horizontal row (a part
      // on its pin's row) has no trunk, and its left end is the pin, so the
      // name sits over the stub and the gap the row left for it. Whichever
      // candidate clears every body wins; the run's top-left point is the
      // last resort.
      const vertTops = r.segs.filter((c) => sameCoord(c.x1, c.x2)).map((c) => ({ x: c.x1, y: Math.min(c.y1, c.y2) }));
      const candidates = [...vertTops.sort((a, b) => a.y - b.y || a.x - b.x), pts[0]!];
      const clearOfBodies = (pt: { x: number; y: number }): boolean => {
        const b = labelTextBox(net.name, pt.x, pt.y, 0);
        if ([...placed.values()].some((pl) => boundsOverlap(b, pl.body))) return false;
        return !labels.some((o) => o.name !== net.name && boundsOverlap(padBox(b), labelTextBox(o.name, o.x, o.y, o.rot)));
      };
      const at = candidates.find(clearOfBodies) ?? pts[0]!;
      labels.push({ name: net.name, x: at.x, y: at.y, rot: 0, kind: 'local' });
      netWired.push(labels.length - 1);
      wiredLabels.push({ label: labels.length - 1, pts, segs: r.segs.map((c) => ({ ...c })) });
      wired++;
      if (subset.length > 2) {
        if (r.trunkY !== undefined) {
          // comb: a branch meeting the row trunk strictly inside its span is a T
          const xs = subset.map((s) => s.end.x);
          for (const s of subset) {
            const meet = sameCoord(s.end.y, r.trunkY) ? s.end : { x: s.end.x, y: r.trunkY };
            if (meet.x > Math.min(...xs) + 0.01 && meet.x < Math.max(...xs) - 0.01) junctions.push(meet);
          }
        } else {
          const ys = subset.map((s) => s.end.y);
          for (const s of subset) {
            const meet = sameCoord(s.end.x, r.trunkX) ? s.end : { x: r.trunkX, y: s.end.y };
            if (meet.y > Math.min(...ys) && meet.y < Math.max(...ys)) junctions.push(meet);
          }
        }
      }
    };

    // Clusters: endpoints in one group whose stub ends sit within wire span of
    // one another, in x order. A net that stays in one group and fits the
    // span is one cluster — the classic case, drawn as before. A net that
    // also leaves the group, or runs longer, still gets each local run wired
    // and labelled once: adjacency before labelling (#220 phase 3), so a part
    // hung on a pin or lying on its row is wired to it whatever the rest of
    // the net does. Lone endpoints keep a stub and a label.
    const sorted: Stub[] = [...stubs].sort((a, b) => a.end.x - b.end.x || a.end.y - b.end.y);
    const clusters: Stub[][] = [];
    const anchorKey = (ref: string): string => {
      let k = ref;
      for (let i = 0; i < 4 && boundTo.has(k); i++) k = boundTo.get(k)!;
      return k;
    };
    const near = (a: Stub, b: Stub): boolean =>
      (Math.abs(a.end.x - b.end.x) <= MAX_WIRE_SPAN && Math.abs(a.end.y - b.end.y) <= MAX_WIRE_SPAN) ||
      // a part hung on a pin or lying on its row joins that pin's cluster
      // however far its lane sits: the fourth lane of a comb is past the
      // wire span, and it is still that pin's part
      anchorKey(a.ep.ref) === anchorKey(b.ep.ref);
    for (const s of sorted) {
      const home = clusters.find((cl) => groupOf.get(cl[0]!.ep.ref) === groupOf.get(s.ep.ref) && cl.every((o) => near(o, s)));
      if (home) home.push(s);
      else clusters.push([s]);
    }
    const wiredStubs = new Set<Stub>();
    for (const cl of clusters) {
      if (cl.length < 2 || cl.length > MAX_WIRED_ENDPOINTS) continue;
      // the whole cluster, else the largest subset that routes: a run on the
      // IC pin's row still draws as a wire when a third endpoint's branch
      // cannot be cleared, and only that endpoint keeps a stub label
      let done = false;
      for (let size = cl.length; size >= 2 && !done; size--) {
        const subsets: Stub[][] = [];
        const pick = (start: number, cur: Stub[]): void => {
          if (cur.length === size) {
            subsets.push([...cur]);
            return;
          }
          for (let i = start; i < cl.length; i++) pick(i + 1, [...cur, cl[i]!]);
        };
        pick(0, []);
        for (const sub of subsets) {
          const r = routeStubs(sub);
          if (!r) continue;
          commitRoute(sub, r);
          for (const s of sub) wiredStubs.add(s);
          done = true;
          break;
        }
      }
    }
    for (const s of stubs) {
      if (wiredStubs.has(s)) continue;
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
      // Rungs in preference order: the classic 0..2 extensions first so
      // clear cases stay byte-identical, then deeper extensions, then a
      // one-unit retreat. A stub that ships with NO clear rung still ends
      // touching a foreign wire and the merge gate refuses the draft, so
      // every extra rung here is a board that drafts instead of refusing
      // (jetson's twelve wire-contact refusals were exactly this fallback).
      for (const len of [STUB, STUB + 1, STUB + 2, STUB + 3, STUB + 4, STUB + 5, STUB + 6, 1]) {
        const cand = {
          x: s.ep.at.x + s.o.dx * len * U,
          y: s.ep.at.y + s.o.dy * len * U,
        };
        if (!touchesForeign([{ x1: s.ep.at.x, y1: s.ep.at.y, x2: cand.x, y2: cand.y }], net.name, own)) {
          end = cand;
          break;
        }
      }
      addWire(net.name, s.ep.at.x, s.ep.at.y, end.x, end.y);
      // a stub ends in a global flag that continues the stub's direction,
      // the way a person hangs a flag on a wire end: a leftward stub reads
      // leftward, an upward one reads upward; the shape says what the pin is
      labels.push({ name: net.name, x: end.x, y: end.y, rot: rotOutward(s.o), kind: 'global', shape: flagShape(s.ep.pin.etype) });
      stubbedLabels.push({ label: labels.length - 1, wire: wires.length - 1, o: s.o, pins: net.pins });
      labelled++;
    }
    // A net that also leaves its run through a stub is named by global flags
    // there, and a local label of the same name would not connect to them in
    // KiCad: the run's own name becomes a flag too, re-anchored where a flag
    // fits (a local name stands over its wire; a flag has a body of its own).
    // A net wired whole keeps its plain local name on the run.
    if (netWired.length && stubs.some((s) => !wiredStubs.has(s))) {
      for (const idx of netWired) {
        const lb = labels[idx]!;
        const rec = wiredLabels.find((w) => w.label === idx)!;
        lb.kind = 'global';
        lb.shape = 'passive';
        const clear = (c: { x: number; y: number; rot: number }): boolean =>
          ![...placed.values()].some((pl) => boundsOverlap(labelTextBox(lb.name, c.x, c.y, c.rot, 'global'), pl.body));
        const at = wiredFlagCandidates(rec.segs).find(clear) ?? { x: lb.x, y: lb.y, rot: 90 };
        trace(`label ${lb.name}: run name becomes a flag at (${at.x}, ${at.y}, ${at.rot})`);
        lb.x = at.x;
        lb.y = at.y;
        lb.rot = at.rot;
      }
    }
  }

  if (process.env['COPPERHEAD_DRAFT_TRACE']) {
    // every crossing of two nets' wires, for the trace: a comb whose lanes
    // cross another pin's row is legal, but a drafter wants to know where
    const H = wires.filter((w) => sameCoord(w.y1, w.y2));
    const V = wires.filter((w) => sameCoord(w.x1, w.x2));
    for (const h of H) {
      for (const v of V) {
        if (h.net === v.net) continue;
        const hx1 = Math.min(h.x1, h.x2), hx2 = Math.max(h.x1, h.x2), vy1 = Math.min(v.y1, v.y2), vy2 = Math.max(v.y1, v.y2);
        if (v.x1 > hx1 + 0.01 && v.x1 < hx2 - 0.01 && h.y1 > vy1 + 0.01 && h.y1 < vy2 - 0.01) trace(`crossing ${h.net} (row y=${h.y1}) x ${v.net} (x=${v.x1})`);
      }
    }
  }

  // ---------- member symbols with collision-free text slots ----------
  // Built BEFORE the label de-collision pass so the pass can treat every
  // visible ref/value text as an obstacle: the checker measures text-vs-text
  // collisions at error severity, so a box the checker will see must be a box
  // the avoider saw first.
  const emitSymbols: EmitSymbol[] = [];
  /** Emit entry with its placement, for the slot-refinement pass below (two
   * unit instances share one refdes, so `ref` alone no longer keys `placed`). */
  const emitPairs: { sym: EmitSymbol; pl: Placed }[] = [];
  /** What KiCad renders for the reference: a multi-unit instance shows its
   * unit letter (U1A, U1B), so width metrics must measure the rendered text. */
  const displayRefOf = (pl: Placed): string =>
    pl.unit !== null ? `${pl.refDes}${String.fromCharCode(64 + Math.min(pl.unit, 26))}` : pl.refDes;
  /**
   * Width of the body interior left free by the pin NAMES drawn inside it on
   * the rows a ref/value pair at `cy` would occupy. A large module's names
   * (ESP32-WROVER's "MTMS/GPIO14/ADC2_CH6") run most of the way across, and a
   * value dropped on the centre line read as one word with them.
   */
  const interiorSpan = (pl: Placed, cy: number): { left: number; right: number } => {
    let leftW = 0;
    let rightW = 0;
    for (const pin of pl.sym.pins) {
      const o = outward(pin);
      if (o.dx === 0) continue;
      const py = pinAt(pl, pin).y;
      if (Math.abs(py - cy) > 2.54 + 0.7) continue;
      const w = Math.max(0, pin.name.length) * NAME_ADVANCE * LABEL_HEIGHT;
      if (o.dx === -1) leftW = Math.max(leftW, w);
      else rightW = Math.max(rightW, w);
    }
    return { left: pl.body.minX + leftW, right: pl.body.maxX - rightW };
  };
  /** A library symbol that draws text of its own inside the body (ESP32-WROVER
   * prints its family name across the middle) has no free interior. */
  const hasGraphicText = (pl: Placed): boolean => /\(text\s/.test(pl.sym.sourceText ?? '');
  const pinSidesOf = (pl: Placed): Set<string> =>
    new Set(
      pl.sym.pins.map((p) => {
        const o = outward(p);
        return o.dx === -1 ? 'left' : o.dx === 1 ? 'right' : o.dy === -1 ? 'top' : 'bottom';
      }),
    );
  for (const [, pl] of [...placed.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const pinSides = pinSidesOf(pl);
    const cy = (pl.body.minY + pl.body.maxY) / 2;
    const cx = (pl.body.minX + pl.body.maxX) / 2;
    const textW = Math.max(displayRefOf(pl).length, pl.part.value.length) * 0.8 * 1.27;
    let refAt: { x: number; y: number };
    let valueAt: { x: number; y: number };
    if (!pinSides.has('top')) {
      refAt = { x: cx, y: pl.body.minY - 2.54 };
      // value stacks above the ref when the bottom also carries pins, and sits
      // below the body otherwise
      valueAt = pinSides.has('bottom') ? { x: cx, y: pl.body.minY - 5.08 } : { x: cx, y: pl.body.maxY + 2.54 };
    } else if (
      pl.body.maxY - pl.body.minY >= 7.62 &&
      !hasGraphicText(pl) &&
      // the name at its real advance, centred in the interval the pin names
      // leave free, with two text heights of air each side: measured from
      // the body centre instead, ESP32-WROVER's value printed across the
      // ends of its long left-hand pin names
      interiorSpan(pl, cy).right - interiorSpan(pl, cy).left >= (textW * NAME_ADVANCE) / LABEL_ADVANCE + 4 * 2.54
    ) {
      // pins on top AND a body big enough to hold its own name: a TQFP-class
      // part carries pins on all four sides, so every outside slot lands on
      // some pin's stub or label; the body interior is the one guaranteed-free
      // area, and it is where KiCad's own large symbols put their text
      const span = interiorSpan(pl, cy);
      const mid = grid(Math.round((span.left + span.right) / 2 / U));
      refAt = { x: mid, y: cy - 1.27 };
      valueAt = { x: mid, y: cy + 1.27 };
    } else {
      refAt = { x: pl.body.maxX + textW / 2 + 1.27, y: cy - 1.27 };
      valueAt = { x: pl.body.maxX + textW / 2 + 1.27, y: cy + 1.27 };
    }
    const sym: EmitSymbol = {
      ref: pl.refDes,
      libId: pl.sym.libId,
      value: pl.part.value,
      footprint: pl.part.footprint ?? '',
      at: { x: pl.x, y: pl.y, rot: pl.rot },
      ...(pl.mirror ? { mirror: pl.mirror } : {}),
      refAt,
      valueAt,
      pinNumbers: pl.sym.pins.map((p) => p.number),
      ...(pl.unit !== null ? { unit: pl.unit } : {}),
    };
    emitSymbols.push(sym);
    emitPairs.push({ sym, pl });
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
    const powerBodies: Bounds[] = extraSymbols.map((s) => ({ minX: s.at.x - 2 * U, minY: s.at.y - 2 * U, maxX: s.at.x + 2 * U, maxY: s.at.y + 2 * U }));
    const labelBoxes: Bounds[] = labels.map((l) => labelTextBox(l.name, l.x, l.y, l.rot, l.kind));
    for (const { sym, pl } of emitPairs) {
      const dref = displayRefOf(pl);
      const cx = (pl.body.minX + pl.body.maxX) / 2;
      const cy = (pl.body.minY + pl.body.maxY) / 2;
      const textW = Math.max(dref.length, sym.value.length) * 0.8 * 1.27;
      const pairClear = (r: { x: number; y: number }, v: { x: number; y: number }): boolean => {
        for (const b of [centeredTextBox(dref, r.x, r.y), centeredTextBox(sym.value, v.x, v.y)]) {
          if (wires.some((w) => segHitsBoxEarly(w, b))) return false;
          for (const op of placed.values()) {
            if (op !== pl && boundsOverlap(b, op.body)) return false;
          }
          // a rail bar or ground symbol is a drawn body too, not just its
          // value text (R23's reference printed through PVDD's bar)
          if (powerBodies.some((pb) => boundsOverlap(b, pb))) return false;
          // the part's own pins: the pin line and its number, from the pin
          // end to the body edge (U8's name printed over its no-connect pins,
          // which draw no wire for the wire check to see)
          for (const pin of pl.sym.pins) {
            const p = pinAt(pl, pin);
            const o = outward(pin);
            const band: Bounds = o.dx !== 0
              ? { minX: Math.min(p.x, o.dx === 1 ? pl.body.maxX : pl.body.minX), maxX: Math.max(p.x, o.dx === 1 ? pl.body.maxX : pl.body.minX), minY: p.y - 1.5, maxY: p.y + 1.5 }
              : { minX: p.x - 1.5, maxX: p.x + 1.5, minY: Math.min(p.y, o.dy === 1 ? pl.body.maxY : pl.body.minY), maxY: Math.max(p.y, o.dy === 1 ? pl.body.maxY : pl.body.minY) };
            if (boundsOverlap(b, band)) return false;
          }
          if (fieldBoxes.some((t) => boundsOverlap(t, padBox(b)))) return false;
          // net labels are on the sheet by now; a slot on top of one is no slot
          if (labelBoxes.some((t) => boundsOverlap(t, padBox(b)))) return false;
        }
        return true;
      };
      if (!pairClear(sym.refAt, sym.valueAt)) {
        const ladder: [{ x: number; y: number }, { x: number; y: number }][] = [];
        // corner slots: a part with a stub on its top or bottom centre (a
        // module's rail pin) still has its top-left and top-right free
        const xl = pl.body.minX + textW / 2 + 1.27;
        const xr = pl.body.maxX - textW / 2 - 1.27;
        // A part lying on a row (leads left and right) has rows one pitch
        // above and below it; its texts fit BETWEEN the rows, half a pitch
        // out from the body, wherever the neighbouring row carries no wire
        // there. Reference above and value below first, then both on one
        // side, then side by side on one line.
        if (pinSidesOf(pl).has('left') && pinSidesOf(pl).has('right') && !pinSidesOf(pl).has('top')) {
          const hh = 1.27;
          // Both texts on ONE side first, and side by side on one line before
          // stacked: two parts on rows two pitches apart then keep their texts
          // in their own half of the gap (C27's value and L3's reference met
          // in the middle of the five millimetres between their rows).
          ladder.push(
            [{ x: cx, y: pl.body.minY - hh - 2.54 }, { x: cx, y: pl.body.minY - hh }],
            [{ x: cx - textW / 2 - 0.635, y: pl.body.minY - hh }, { x: cx + textW / 2 + 0.635, y: pl.body.minY - hh }],
            [{ x: cx, y: pl.body.maxY + hh }, { x: cx, y: pl.body.maxY + hh + 2.54 }],
            [{ x: cx - textW / 2 - 0.635, y: pl.body.maxY + hh }, { x: cx + textW / 2 + 0.635, y: pl.body.maxY + hh }],
            [{ x: cx, y: pl.body.minY - hh }, { x: cx, y: pl.body.maxY + hh }],
          );
        }
        // rungs reach past a rail symbol and its name on a top or bottom
        // stub (about 6 mm out), so a module pinned on all four sides still
        // finds a slot above or below itself instead of on its own labels
        for (const extra of [0, 2.54, 5.08, 7.62, 10.16]) {
          ladder.push(
            [{ x: cx, y: pl.body.maxY + 2.54 + extra }, { x: cx, y: pl.body.maxY + 5.08 + extra }],
            [{ x: cx, y: pl.body.minY - 5.08 - extra }, { x: cx, y: pl.body.minY - 2.54 - extra }],
            [{ x: xl, y: pl.body.minY - 5.08 - extra }, { x: xl, y: pl.body.minY - 2.54 - extra }],
            [{ x: xr, y: pl.body.minY - 5.08 - extra }, { x: xr, y: pl.body.minY - 2.54 - extra }],
            [{ x: xl, y: pl.body.maxY + 2.54 + extra }, { x: xl, y: pl.body.maxY + 5.08 + extra }],
            [{ x: xr, y: pl.body.maxY + 2.54 + extra }, { x: xr, y: pl.body.maxY + 5.08 + extra }],
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
        let slotted = false;
        for (const [r, v] of ladder) {
          if (pairClear(r, v)) {
            sym.refAt = r;
            sym.valueAt = v;
            slotted = true;
            break;
          }
        }
        if (!slotted) trace(`fields of ${dref}: no clear slot in ${ladder.length} rungs; heuristic kept`);
      }
      fieldBoxes.push(centeredTextBox(dref, sym.refAt.x, sym.refAt.y), centeredTextBox(sym.value, sym.valueAt.x, sym.valueAt.y));
    }
  }

  /** Every visible ref/value text the checker will measure. */
  const textObstacles: Bounds[] = [
    ...emitPairs.flatMap(({ sym: s, pl }) => [centeredTextBox(displayRefOf(pl), s.refAt.x, s.refAt.y), centeredTextBox(s.value, s.valueAt.x, s.valueAt.y)]),
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
    const clearWired = (x: number, y: number, rot: number, pad = TEXT_PAD): boolean => {
      const box = labelTextBox(lb.name, x, y, rot, lb.kind);
      const padBox = (b: Bounds): Bounds => ({ minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad });
      const blocked = (why: string): false => {
        trace(`label ${lb.name} at (${x}, ${y}, ${rot}) blocked by ${why}`);
        return false;
      };
      // A wire through the anchor is the label's own attachment — for a
      // plain label, whose text stands above the line. A flag is drawn
      // CENTRED on its anchor line, so a wire continuing under its text
      // runs straight through the flag; only the wire on the pole side
      // (behind the flag's tip) is its attachment.
      const attached = (w: { x1: number; y1: number; x2: number; y2: number }): boolean => {
        if (!segContains(w, x, y)) return false;
        if (lb.kind !== 'global') return true;
        const r = ((rot % 360) + 360) % 360;
        if (r === 0) return Math.max(w.x1, w.x2) <= x + 0.01;
        if (r === 180) return Math.min(w.x1, w.x2) >= x - 0.01;
        if (r === 90) return Math.min(w.y1, w.y2) >= y - 0.01;
        return Math.max(w.y1, w.y2) <= y + 0.01;
      };
      const hitBody = [...placed.entries()].find(([, pl]) => boundsOverlap(box, pl.body));
      if (hitBody) return blocked(`the body of ${hitBody[0]} (${JSON.stringify(hitBody[1].body)})`);
      if (textObstacles.some((b) => boundsOverlap(padBox(box), b))) return blocked('field text');
      if (wires.some((w) => !attached(w) && segHitsBox(w, box))) return blocked('a wire');
      return !labels.some(
        (o, i) => i !== rec.label && o.name !== lb.name && boundsOverlap(padBox(box), labelTextBox(o.name, o.x, o.y, o.rot, o.kind)),
      );
    };
    if (clearWired(lb.x, lb.y, lb.rot)) continue;
    trace(`label ${lb.name}: (${lb.x}, ${lb.y}, ${lb.rot}) not clear, searching`);
    // A flag may turn as well as move — its candidates each carry a rotation
    // — and prefers a trunk top; a local name stays horizontal and walks the
    // run's points in anchor-preference order.
    if (lb.kind === 'global') {
      // a run's name reads along the row (the drafting standard keeps text
      // horizontal); a flag that could only stand up leaves the net to
      // local labels below
      const alt = wiredFlagCandidates(rec.segs)
        .filter((c) => c.rot === 0 || c.rot === 180)
        .find((c) => clearWired(c.x, c.y, c.rot));
      if (alt) {
        lb.x = alt.x;
        lb.y = alt.y;
        lb.rot = alt.rot;
        continue;
      }
      // A flag that fits nowhere on its run (a part on a pin row of a
      // 2.54 mm-pitch IC has no free end and no room for a flag standing up
      // between the rows) leaves the net named by plain labels instead:
      // every flag of this net becomes a local label, which KiCad connects
      // across the sheet just the same, and the run's name goes back to
      // standing on its wire.
      for (const o of labels) {
        if (o.name !== lb.name) continue;
        o.kind = 'local';
        delete o.shape;
        if (o.rot === 90 || o.rot === 270) o.rot = 0; // plain text reads along the row
      }
      lb.rot = 0;
      trace(`label ${lb.name}: no flag position clears; the net keeps local labels`);
    }
    const alt = rec.pts.find((p) => clearWired(p.x, p.y, 0));
    if (alt) {
      trace(`label ${lb.name} moved along its run (${lb.x}, ${lb.y}) -> (${alt.x}, ${alt.y})`);
      lb.x = alt.x;
      lb.y = alt.y;
      continue;
    }
    // reading leftward from a point on the run is the same text on the same
    // wire; a run whose right-hand end is a part's body (a resistor on the
    // row) often clears only that way
    const altLeft = [...rec.pts, ...interiorGridPoints(rec.segs, U)].find((p) => clearWired(p.x, p.y, 180));
    if (altLeft) {
      trace(`label ${lb.name} reads leftward from (${altLeft.x}, ${altLeft.y})`);
      lb.x = altLeft.x;
      lb.y = altLeft.y;
      lb.rot = 180;
      continue;
    }
    // No segment endpoint clears, but the label may sit at ANY point of its
    // own net's wires: walk the interior grid points of each segment too
    // (#220 phase 2). Endpoints stay the first choice so a run that used to
    // clear keeps its exact label point.
    //
    // Walk `segs`, never `pts`: `pts` is sorted for anchor preference, so
    // pairing it up interpolates between two points that share no wire and
    // anchors the label in open sheet, where KiCad attaches nothing and the
    // net silently carries whatever name KiCad invents for it instead of the
    // one the IR gave it. Three corpus nets shipped exactly that way —
    // Net-(F201-Pad1), Net-(U8-BIN) and Net-(U8-RIN), each anchored on no
    // wire of its own run.
    const inner = interiorGridPoints(rec.segs, U).find((p) => clearWired(p.x, p.y, 0));
    if (inner) {
      trace(`label ${lb.name} moved to an interior point (${inner.x}, ${inner.y})`);
      lb.x = inner.x;
      lb.y = inner.y;
      continue;
    }
    // Last resort before leaving the name on a body: the full pad cannot be
    // had on a 2.54 mm pin row under a flag (a flag's half height plus a
    // standing label's height already fill the pitch), so accept a quarter
    // pad at the first point that clears everything else.
    // (A flag on the row above already reaches a full height below its line,
    // so against it even a quarter pad is too much; touching boxes are not a
    // collision to the checker, and are the last rung.)
    const tightCandidates = [...rec.pts.map((p) => ({ ...p, rot: 0 })), ...interiorGridPoints(rec.segs, U).map((p) => ({ ...p, rot: 0 })), ...rec.pts.map((p) => ({ ...p, rot: 180 }))];
    const tight = tightCandidates.find((c) => clearWired(c.x, c.y, c.rot, TEXT_PAD / 4)) ?? tightCandidates.find((c) => clearWired(c.x, c.y, c.rot, 0));
    if (tight) {
      trace(`label ${lb.name} placed at (${tight.x}, ${tight.y}, ${tight.rot}) with a reduced pad`);
      lb.x = tight.x;
      lb.y = tight.y;
      lb.rot = tight.rot;
      continue;
    }
    trace(`label ${lb.name}: no clear point on its run; left at (${lb.x}, ${lb.y})`);
  }

  for (const rec of stubbedLabels) {
    const lb = labels[rec.label]!;
    const stub = wires[rec.wire]!;
    const clearAt = (x: number, y: number, rot: number = lb.rot): boolean => {
      const box = labelTextBox(lb.name, x, y, rot, lb.kind);
      if (bodies.some((b) => boundsOverlap(box, b))) return false;
      if (textObstacles.some((b) => boundsOverlap(padBox(box), b))) return false;
      if (wires.some((w, i) => i !== rec.wire && segHitsBox(w, box))) return false;
      // Foreign labels are part of what a label must clear, not just bodies and
      // wires. Without this the pass declares a point clear that another net's
      // label already holds, both labels stay put, and `findMergedNets` then
      // refuses the draft for a collision the avoider was never looking for —
      // an engine state no IR can steer out of, because the IR does not choose
      // coordinates. Read live from `labels`, so already-nudged neighbours are
      // seen at their final positions and immovable wired-net labels (which
      // carry no stub to ride) are seen at all.
      // A label of the SAME net is still text: two BUCK_EN labels one over
      // the other read as one smudge and the checker flags them (a hung
      // part's stub label rode down onto the IC pin's).
      return !labels.some((o, i) => i !== rec.label && boundsOverlap(padBox(box), labelTextBox(o.name, o.x, o.y, o.rot, o.kind)));
    };
    /**
     * Does another net's label sit on exactly this point? That is the fatal
     * case — KiCad fuses the two nets — as opposed to merely overlapping text.
     */
    const mergesAt = (x: number, y: number): boolean =>
      labels.some((o, i) => i !== rec.label && o.name !== lb.name && sameCoord(o.x, x) && sameCoord(o.y, y));
    /**
     * Riding a label outward drags the stub's ENDPOINT with it (`rideTo` moves
     * both). Every test above this asks a typographic question — does the text
     * box clear a body, a wire, another label — and none asks the electrical
     * one, so the pass could answer "the text is clear here" about a point that
     * sits on another net's wire and silently tie the two together (#217:
     * interf_u rode /PC-RD's stub from 2 units to 4 and parked its end on
     * /WR_REG's trunk).
     *
     * A candidate must therefore be electrically clear as well as legible.
     * The stub's own wire needs no exclusion: `touchesForeign` skips wires of
     * the same net, and this one is the net's own.
     */
    const wireClearAt = (x: number, y: number): boolean =>
      !touchesForeign([{ x1: stub.x1, y1: stub.y1, x2: x, y2: y }], lb.name, new Set(rec.pins), {
        predictStubs: false,
      });
    const rideTo = (x: number, y: number): void => {
      stub.x2 = x;
      stub.y2 = y;
      lb.x = x;
      lb.y = y;
    };
    // A flag on a vertical stub reads along the row when nothing stands
    // there (the drafting standard keeps text horizontal; the checker names
    // every rotated label a horizontal one would have fitted).
    if (lb.kind === 'global' && rec.o.dy !== 0 && (lb.rot === 90 || lb.rot === 270)) {
      const flat = [0, 180].find((r) => clearAt(lb.x, lb.y, r) && !mergesAt(lb.x, lb.y));
      if (flat !== undefined) {
        lb.rot = flat;
        continue;
      }
      trace(`flag ${lb.name} at (${lb.x}, ${lb.y}) stays vertical: no horizontal draw clears`);
    }
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
    // Last rung: pull the stub BACK to one unit. Riding outward moves a
    // facing pair's text toward each other, so two long names in a tight
    // channel can never separate that way — but each is under a grid unit
    // deep into the other, and one unit of retreat clears it (#220 phase 2).
    {
      const shortened = { x: stub.x1 + rec.o.dx * U, y: stub.y1 + rec.o.dy * U };
      if (Math.abs(lb.x - stub.x1) + Math.abs(lb.y - stub.y1) > U + 0.01) candidates.push(shortened);
    }
    const clear = candidates.find((c) => clearAt(c.x, c.y) && wireClearAt(c.x, c.y));
    if (clear) {
      rideTo(clear.x, clear.y);
      continue;
    }
    // A vertical stub may flip its text to the other side of the anchor: a
    // trunk running parallel beside the stub blocks every rung on one side
    // while the other side is empty (#220 phase 2). The anchor point itself is
    // unchanged, so this is purely typographic — but the flipped box no longer
    // overlaps a same-point foreign label, so the merge check must be explicit.
    if (rec.o.dy !== 0) {
      const flipRot = lb.rot === 0 ? 180 : 0;
      const flip = [{ x: lb.x, y: lb.y }, ...candidates].find(
        (c) =>
          clearAt(c.x, c.y, flipRot) &&
          !mergesAt(c.x, c.y) &&
          (sameCoord(c.x, lb.x) && sameCoord(c.y, lb.y) ? true : wireClearAt(c.x, c.y)),
      );
      if (flip) {
        lb.rot = flipRot;
        rideTo(flip.x, flip.y);
        continue;
      }
    }
    // Nothing fully clear within the nudge budget. Overlapping text is a
    // legibility cost the sheet can carry and the report will name; a shared
    // point is a merged net and refuses the whole draft. So when the label is
    // currently ON another net's point, take the nearest candidate that at
    // least breaks the coincidence — trading a refusal for a flagged blemish.
    // A label that merely overlaps is left alone: moving it would buy nothing
    // and the emitted sheet must stay a function of the IR alone.
    if (!mergesAt(lb.x, lb.y)) continue;
    // Same precedence as above, one rung down: this is already the consolation
    // move for a label sitting on another net's point, so it may accept
    // overlapping text, but it still may not trade one merge for another.
    const unmerged = candidates.find((c) => !mergesAt(c.x, c.y) && wireClearAt(c.x, c.y));
    if (unmerged) rideTo(unmerged.x, unmerged.y);
  }

  // ---------- power-value sweep (#220 phase 2) ----------
  // The power pass placed its value text before any signal label existed, and
  // the label ride above can fail to clear in a dense row — whichever mover
  // ran last was blind to the other, and cm5_minima's residual error findings
  // were exactly "#PWR Value and label X overlap". The value text is the one
  // item on the sheet with no electrical meaning, so it moves LAST, with the
  // finished drawing as its obstacle set: slide it outward along its stub
  // axis, then allow a small lateral step, to the first slot the checker will
  // measure as clean. Nothing clear keeps the placed slot so the report stays
  // honest, and a value that is already clean does not move at all.
  {
    const labelBoxesFinal = labels.map((l) => labelTextBox(l.name, l.x, l.y, l.rot, l.kind));
    const memberText = emitPairs.flatMap(({ sym: s, pl }) => [
      centeredTextBox(displayRefOf(pl), s.refAt.x, s.refAt.y),
      centeredTextBox(s.value, s.valueAt.x, s.valueAt.y),
    ]);
    const valueEntries = extraSymbols.filter((s) => !s.hideValue);
    const liveBoxes = new Map(valueEntries.map((s) => [s, powerValueBox(s.value, s.valueAt.x, s.valueAt.y)]));
    const clearFor = (self: EmitSymbol, b: Bounds): boolean =>
      !bodies.some((bd) => boundsOverlap(b, bd)) &&
      !wires.some((w) => segHitsBoxEarly(w, b)) &&
      !labelBoxesFinal.some((lb) => boundsOverlap(lb, b)) &&
      !memberText.some((t) => boundsOverlap(t, b)) &&
      ![...liveBoxes].some(([o, ob]) => o !== self && boundsOverlap(ob, b));
    for (const s of valueEntries) {
      if (clearFor(s, liveBoxes.get(s)!)) continue;
      // outward = the side of the symbol the text was already offset to
      const dir = Math.sign(s.valueAt.y - s.at.y) || -1;
      const cands: { x: number; y: number }[] = [];
      for (let k = 1; k <= 8; k++) cands.push({ x: s.valueAt.x, y: s.valueAt.y + dir * k * U });
      for (let k = 0; k <= 8; k++) {
        for (const lx of [U, -U, 2 * U, -2 * U, 3 * U, -3 * U, 4 * U, -4 * U]) {
          cands.push({ x: s.valueAt.x + lx, y: s.valueAt.y + dir * k * U });
        }
      }
      const found = cands.find((c) => clearFor(s, powerValueBox(s.value, c.x, c.y)));
      if (found) {
        s.valueAt = { x: found.x, y: found.y };
        liveBoxes.set(s, powerValueBox(s.value, found.x, found.y));
      }
    }
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

  // no-connect markers (design D6a); a common pin's marker lands on every
  // placed appearance, mirroring how the wiring passes treat such pins
  const noConnects: { x: number; y: number }[] = [];
  for (const ep of intent.noConnect ?? []) {
    const m = /^([^.]+)\.(.+)$/.exec(ep);
    if (!m) continue;
    for (const inst of expandEp(m[1]!, m[2]!)) {
      const pl = placed.get(inst.key);
      const pin = pl?.sym.pins.find((p) => p.number === m[2]);
      if (pl && pin) noConnects.push(pinAt(pl, pin));
    }
  }

  // ---------- sheet: content-derived paper, balanced placement ----------
  // ---------- group boxes enclose their text ----------
  // A box drawn from bodies plus a fixed margin cuts through the text its
  // parts carry: with the IC in the leftmost column, its left-facing pin
  // labels ran out through the box edge (EN, BTN_PLAY, SPK_L+ on esp32-amp),
  // and a rail name on a connector stub crossed the line on every reference
  // board. Grow each box to hold its members' stub labels, their reference
  // and value fields, and the power symbols on their pins, plus BOX_PAD; the
  // group gaps above were widened for exactly this text, so boxes stay clear
  // of one another.
  {
    const pinGroup = new Map<string, string>();
    for (const [key, pl] of placed) {
      const g = groupOf.get(key);
      if (!g) continue;
      for (const pin of pl.sym.pins) {
        const p = pinAt(pl, pin);
        pinGroup.set(pointKey(p.x, p.y), g);
      }
    }
    const boxesOf = new Map<string, Bounds[]>();
    const addBox = (g: string | undefined, b: Bounds): void => {
      if (!g) return;
      boxesOf.set(g, [...(boxesOf.get(g) ?? []), b]);
    };
    // a label at the end of a stub that starts on a member pin
    for (const lb of labels) {
      const stub = wires.find((w) => sameCoord(w.x2, lb.x) && sameCoord(w.y2, lb.y) && pinGroup.has(pointKey(w.x1, w.y1)));
      const g = stub ? pinGroup.get(pointKey(stub.x1, stub.y1)) : undefined;
      addBox(g, labelReserveBox(lb.name, lb.x, lb.y, lb.rot, lb.kind));
    }
    // reference and value fields of every member, at the reserve advance
    const fieldBox = (text: string, x: number, y: number): Bounds => {
      const w = Math.max(1, text.length) * TEXT_RESERVE * LABEL_HEIGHT;
      return { minX: x - w / 2, minY: y - LABEL_HEIGHT / 2, maxX: x + w / 2, maxY: y + LABEL_HEIGHT / 2 };
    };
    const keyOfPlaced = new Map<Placed, string>([...placed.entries()].map(([k, p]) => [p, k]));
    for (const { sym, pl } of emitPairs) {
      const g = groupOf.get(keyOfPlaced.get(pl) ?? '');
      addBox(g, fieldBox(displayRefOf(pl), sym.refAt.x, sym.refAt.y));
      addBox(g, fieldBox(sym.value, sym.valueAt.x, sym.valueAt.y));
    }
    // power symbols on member stubs, with their value text
    for (const ps of extraSymbols) {
      const stub = wires.find((w) => sameCoord(w.x2, ps.at.x) && sameCoord(w.y2, ps.at.y) && pinGroup.has(pointKey(w.x1, w.y1)));
      const g = stub ? pinGroup.get(pointKey(stub.x1, stub.y1)) : undefined;
      if (!g) continue;
      addBox(g, { minX: ps.at.x - 2 * U, minY: ps.at.y - 2 * U, maxX: ps.at.x + 2 * U, maxY: ps.at.y + 2 * U });
      if (!ps.hideValue) addBox(g, powerValueBox(ps.value, ps.valueAt.x, ps.valueAt.y));
    }
    // every member body too: a hung part on a shared lane or an infilled
    // cell may sit past the cells the rect was first drawn from
    for (const [key, pl] of placed) {
      const g = groupOf.get(key);
      if (g) addBox(g, pl.body);
    }
    for (const r of groupRects) {
      for (const b of boxesOf.get(r.name) ?? []) {
        r.x1 = Math.min(r.x1, b.minX - BOX_PAD * U);
        r.x2 = Math.max(r.x2, b.maxX + BOX_PAD * U);
        r.y1 = Math.min(r.y1, b.minY - BOX_PAD * U);
        r.y2 = Math.max(r.y2, b.maxY + BOX_PAD * U);
      }
      // The caption sits in the box's top-left corner; text the box grew to
      // hold up there (a rail name over a part rising from the top pin of an
      // IC in that corner) would print straight through it. Anything under
      // the caption's span pushes the top edge up by the caption's own band.
      const capW = 2 + Math.max(1, r.name.length) * LABEL_ADVANCE * CAPTION_SIZE;
      for (const b of boxesOf.get(r.name) ?? []) {
        if (b.minX < r.x1 + capW && b.maxX > r.x1) r.y1 = Math.min(r.y1, b.minY - (2 + CAPTION_SIZE + BOX_PAD * U));
      }
      r.y1 = grid(Math.floor(r.y1 / U));
    }
    // Boxes in one row of the wrap share a bottom edge, boxes in one column
    // a right edge, when the neighbour's space is free anyway: a row of
    // boxes ending at three different heights reads as three afterthoughts.
    if (fit.wrap) {
      const byLine = new Map<number, typeof groupRects>();
      for (const [i, r] of groupRects.entries()) {
        const d = fit.wrap.deltas[i]!;
        const line = fit.wrap.kind === 'columns' ? d.dx : d.dy;
        byLine.set(line, [...(byLine.get(line) ?? []), r]);
      }
      for (const line of byLine.values()) {
        if (line.length < 2) continue;
        if (fit.wrap.kind === 'columns') {
          const right = Math.max(...line.map((r) => r.x2));
          for (const r of line) r.x2 = right;
        } else {
          const bottom = Math.max(...line.map((r) => r.y2));
          for (const r of line) r.y2 = bottom;
        }
      }
    }
  }

  // ---------- measure what every cell drew (for the squeeze), before the sheet shift ----------
  // Every drawn item is attributed to the cells it belongs to: a body and its
  // fields to their instance; a wire, with the labels and power symbols on
  // it, to every instance with a pin on its run (a comb belongs to the IC and
  // the parts hung on it, which roll up to the IC below). A cell's overhang is
  // then how far that union reaches past its body on each side.
  const measuredOut = new Map<string, Overhang>();
  {
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let r = k;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const union = (a: string, b: string): void => {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const w of wires) union(pointKey(w.x1, w.y1), pointKey(w.x2, w.y2));
    const boxes = new Map<string, Bounds>();
    const dbgSrc = new Map<string, string[]>();
    const extend = (key: string, b: Bounds, why = 'body'): void => {
      if (process.env['COPPERHEAD_DRAFT_TRACE']) dbgSrc.set(key, [...(dbgSrc.get(key) ?? []), `${why}[${b.minX.toFixed(0)},${b.minY.toFixed(0)}..${b.maxX.toFixed(0)},${b.maxY.toFixed(0)}]`]);
      const cur = boxes.get(key);
      boxes.set(key, cur ? { minX: Math.min(cur.minX, b.minX), minY: Math.min(cur.minY, b.minY), maxX: Math.max(cur.maxX, b.maxX), maxY: Math.max(cur.maxY, b.maxY) } : { ...b });
    };
    const compOwners = new Map<string, Set<string>>();
    for (const [key, pl] of placed) {
      extend(key, pl.body);
      for (const pin of pl.sym.pins) {
        const p = pinAt(pl, pin);
        const pk = pointKey(p.x, p.y);
        if (!parent.has(pk)) continue;
        const c = find(pk);
        compOwners.set(c, (compOwners.get(c) ?? new Set<string>()).add(key));
      }
    }
    const keyOf = new Map<Placed, string>([...placed.entries()].map(([k, p]) => [p, k]));
    for (const { sym, pl } of emitPairs) {
      const key = keyOf.get(pl);
      if (!key) continue;
      extend(key, centeredTextBox(displayRefOf(pl), sym.refAt.x, sym.refAt.y), 'ref');
      extend(key, centeredTextBox(sym.value, sym.valueAt.x, sym.valueAt.y), 'value');
    }
    const compBox = new Map<string, Bounds>();
    const extendComp = (c: string, b: Bounds): void => {
      const cur = compBox.get(c);
      compBox.set(c, cur ? { minX: Math.min(cur.minX, b.minX), minY: Math.min(cur.minY, b.minY), maxX: Math.max(cur.maxX, b.maxX), maxY: Math.max(cur.maxY, b.maxY) } : { ...b });
    };
    for (const w of wires) extendComp(find(pointKey(w.x1, w.y1)), { minX: Math.min(w.x1, w.x2), minY: Math.min(w.y1, w.y2), maxX: Math.max(w.x1, w.x2), maxY: Math.max(w.y1, w.y2) });
    const compAt = (x: number, y: number): string | null => {
      const pk = pointKey(x, y);
      if (parent.has(pk)) return find(pk);
      const w = wires.find((s) => segContains(s, x, y));
      return w ? find(pointKey(w.x1, w.y1)) : null;
    };
    for (const l of labels) {
      const c = compAt(l.x, l.y);
      if (c) extendComp(c, labelTextBox(l.name, l.x, l.y, l.rot, l.kind));
    }
    for (const ps of extraSymbols) {
      const c = compAt(ps.at.x, ps.at.y);
      if (!c) continue;
      extendComp(c, { minX: ps.at.x - 2 * U, minY: ps.at.y - 2 * U, maxX: ps.at.x + 2 * U, maxY: ps.at.y + 2 * U });
      if (!ps.hideValue) extendComp(c, powerValueBox(ps.value, ps.valueAt.x, ps.valueAt.y));
    }
    const rootOf = (k: string): string => {
      let r = k;
      for (let i = 0; i < 6 && boundTo.has(r); i++) r = boundTo.get(r)!;
      return r;
    };
    // A run with one owner cell (an IC and the parts hung on it) is that
    // cell's; a run shared by several independent cells (a bank's rail and
    // ground trunks, a cluster wire between two column parts) gives each
    // owner only the wires that touch its own pins, with the labels and
    // symbols at their far ends — attributed whole, a bank's trunk made every
    // capacitor's cell as wide as the bank.
    const pinComp = new Map<string, string>(); // pin point -> owner key
    for (const [key, pl] of placed) for (const pin of pl.sym.pins) {
      const p = pinAt(pl, pin);
      pinComp.set(pointKey(p.x, p.y), key);
    }
    const itemsAt = new Map<string, Bounds[]>(); // point -> boxes of labels/symbols anchored there
    const addItem = (x: number, y: number, b: Bounds): void => {
      itemsAt.set(pointKey(x, y), [...(itemsAt.get(pointKey(x, y)) ?? []), b]);
    };
    for (const l of labels) addItem(l.x, l.y, labelTextBox(l.name, l.x, l.y, l.rot, l.kind));
    for (const ps of extraSymbols) {
      addItem(ps.at.x, ps.at.y, { minX: ps.at.x - 2 * U, minY: ps.at.y - 2 * U, maxX: ps.at.x + 2 * U, maxY: ps.at.y + 2 * U });
      if (!ps.hideValue) addItem(ps.at.x, ps.at.y, powerValueBox(ps.value, ps.valueAt.x, ps.valueAt.y));
    }
    for (const [c, owners] of compOwners) {
      const roots = new Set([...owners].map(rootOf));
      const b = compBox.get(c);
      if (!b) continue;
      if (roots.size === 1) {
        extend([...roots][0]!, b, `run(${[...owners].join('+')})`);
        continue;
      }
      for (const w of wires) {
        if (find(pointKey(w.x1, w.y1)) !== c) continue;
        const ends = [pointKey(w.x1, w.y1), pointKey(w.x2, w.y2)];
        const touching = new Set(ends.map((e) => pinComp.get(e)).filter((k): k is string => k !== undefined).map(rootOf));
        for (const r of touching) {
          extend(r, { minX: Math.min(w.x1, w.x2), minY: Math.min(w.y1, w.y2), maxX: Math.max(w.x1, w.x2), maxY: Math.max(w.y1, w.y2) }, `wire(${w.net})`);
          for (const e of ends) for (const ib of itemsAt.get(e) ?? []) extend(r, ib, `item@${e}`);
        }
      }
    }
    for (const [key, b] of [...boxes.entries()]) {
      const r = rootOf(key);
      if (r !== key) extend(r, b, `child ${key}`);
    }
    for (const [key, pl] of placed) {
      if (rootOf(key) !== key) continue;
      const b = boxes.get(key);
      if (!b) continue;
      if (process.env['COPPERHEAD_DRAFT_TRACE'] && (b.maxX - b.minX > 4 * (pl.body.maxX - pl.body.minX) + 30 || b.maxY - b.minY > 4 * (pl.body.maxY - pl.body.minY) + 30)) {
        trace(`measured ${key}: drawn extent ${(b.maxX - b.minX).toFixed(0)}x${(b.maxY - b.minY).toFixed(0)} mm around a ${(pl.body.maxX - pl.body.minX).toFixed(0)}x${(pl.body.maxY - pl.body.minY).toFixed(0)} body <- ${(dbgSrc.get(key) ?? []).slice(0, 12).join(' ')}`);
      }
      measuredOut.set(key, {
        left: Math.max(0, pl.body.minX - b.minX),
        right: Math.max(0, b.maxX - pl.body.maxX),
        top: Math.max(0, pl.body.minY - b.minY),
        bottom: Math.max(0, b.maxY - pl.body.maxY),
      });
    }
  }

  const allX = [...groupRects.map((r) => r.x1), ...groupRects.map((r) => r.x2)];
  const allY = [...groupRects.map((r) => r.y1), ...groupRects.map((r) => r.y2)];
  const contentW = allX.length ? Math.max(...allX) - Math.min(...allX) : 0;
  const contentH = allY.length ? Math.max(...allY) - Math.min(...allY) : 0;
  // The sheet was already decided by the wrap-and-band pass above: `fit` names
  // the smallest candidate the final group rects fit (or the largest, noted,
  // when nothing holds them). Re-deriving it from content here could only
  // disagree with the budget the columns were banded to.
  const paper = fit.paper;

  // offset so content sits centered in the usable area (whitespace balance,
  // design D11), snapped to the grid so origins stay grid-true
  const minX = allX.length ? Math.min(...allX) : 0;
  const minY = allY.length ? Math.min(...allY) : 0;
  const availW = paper.w - 2 * FRAME;
  const availH = paper.h - 2 * FRAME - TITLE_STRIP;
  let dx = grid(Math.round((FRAME + Math.max(0, (availW - contentW) / 2) - minX) / U));
  let dy = grid(Math.round((FRAME + 4 * U + Math.max(0, (availH - contentH) / 2) - minY) / U));

  // The group rects measure bodies plus margins; label TEXT extends past them
  // at the sheet-facing edges, and on a sheet banded near the full usable
  // width the centered offset leaves that text outside the frame (#220
  // phase 1). Clamp the shift against the true extent, label boxes included:
  // a whole-unit correction keeps the grid, fires only when text would cross
  // the frame, and an extent wider than the window keeps the centered offset
  // (that overflow was already noted by the fit pass).
  const textBoxes = [
    ...labels.map((l) => labelTextBox(l.name, l.x, l.y, l.rot, l.kind)),
    // power VALUE text is measured by the checker too, and the sweep above
    // may have slid it past its group rect's margin (pic_programmer put a
    // rail name 1 mm over the top edge of a compacted sheet)
    ...extraSymbols.filter((s) => !s.hideValue).map((s) => powerValueBox(s.value, s.valueAt.x, s.valueAt.y)),
    // group captions: left-top justified at CAPTION_SIZE from the box
    // corner, the way emit.ts writes them and the checker measures them; a
    // long caption on a narrow group can outrun the box's right edge
    ...groupRects.map((r): Bounds => ({ minX: r.x1 + 2, minY: r.y1 + 2, maxX: r.x1 + 2 + Math.max(1, r.name.length) * LABEL_ADVANCE * CAPTION_SIZE, maxY: r.y1 + 2 + CAPTION_SIZE })),
  ];
  const fullMinX = Math.min(minX, ...textBoxes.map((b) => b.minX));
  const fullMaxX = Math.max(minX + contentW, ...textBoxes.map((b) => b.maxX));
  const fullMinY = Math.min(minY, ...textBoxes.map((b) => b.minY));
  const fullMaxY = Math.max(minY + contentH, ...textBoxes.map((b) => b.maxY));
  // Both edges are corrected, far edge first, so the whole-unit rounding of
  // the far-edge shift can never leave the near edge (the checker-visible
  // frame line) outside: the near-edge correction runs last and wins. When
  // the span nearly fills the window, the far edge may keep up to one unit
  // of overhang into the engine's conservative title strip; the strip is
  // wider than the checker's reserved corner, so that overhang is invisible.
  const clampShift = (d: number, lo0: number, hi0: number, lo: number, hi: number): number => {
    if (hi0 - lo0 > hi - lo) return d;
    if (hi0 + d > hi) d -= Math.ceil((hi0 + d - hi) / U - 1e-9) * U;
    if (lo0 + d < lo) d += Math.ceil((lo - lo0 - d) / U - 1e-9) * U;
    return d;
  };
  dx = clampShift(dx, fullMinX, fullMaxX, FRAME, paper.w - FRAME);
  // the bottom edge is the engine's own usable bottom, ABOVE the title strip:
  // content that fills the sheet's height exactly would otherwise carry the
  // centering pass's 4-unit downward offset into the reserved corner
  dy = clampShift(dy, fullMinY, fullMaxY, FRAME, fit.intoStrip ? paper.h - FRAME : paper.h - FRAME - TITLE_STRIP);
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
    netColors: netColorsOf(intent.nets, netClasses),
  };

  const report: SchematicDraftReport = {
    groups: groupNames.map((g) => ({
      name: g,
      // instance keys fold back to refdes (a dual opamp is one member, not two)
      members: [
        ...new Set([...groupOf.entries()].filter(([, gg]) => gg === g).map(([k]) => placed.get(k)?.refDes ?? k)),
      ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    })),
    netClasses: [...netClasses.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, c]) => ({ name, class: c.cls, overridden: c.overridden, basis: c.basis })),
    wireCount: wires.length,
    labelCount: labels.length,
    pwrFlags,
    noConnects: noConnects.length,
    sheetFit: {
      paper: paper.name,
      inkUtilization: [...placed.values()].reduce((a, p) => a + p.cellW * p.cellH * U * U, 0) / (usableW(paper) * usableH(paper)),
      compaction,
      misses: [...budgetMisses],
    },
    paper: paper.name,
    notes,
    mergedNets,
    labelOverlaps,
    labelOverlapBudgetExceeded,
  };
  return { model, report, rects: groupRects, measured: measuredOut };
}

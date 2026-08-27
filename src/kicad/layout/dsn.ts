/**
 * Specctra DSN/SES bridge (issue #252): emit a Design (`.dsn`) the autorouters
 * consume, and read the Session (`.ses`) they write back. No `kicad-cli`
 * Specctra export exists, so this is copperhead's own bridge, kept single-language
 * and CI-portable.
 *
 * The grammar here is deliberately modelled on KiCad's own Specctra exporter,
 * because that is the dialect Freerouting is actually tested against. Three
 * conventions are load-bearing, and getting any of them wrong fails silently
 * (a router that reads the file but routes the wrong board):
 *
 * 1. **Resolution.** `(resolution um 10)` + `(unit um)` means coordinates are in
 *    *micrometres*; the resolution value states the granularity (0.1 um), it is
 *    **not** a divisor applied to coordinates. Read off KiCad's own export, where
 *    a 70 mm board's boundary spans 70000 units and the padstack named
 *    `Round[A]Pad_1200_um` carries the shape `(circle F.Cu 1200)`. Treating the
 *    value as a divisor shrinks the whole board 10x. {@link mmToDsn} and
 *    {@link dsnToMm} are the single conversion point.
 * 2. **Y axis.** DSN is Y-up; KiCad (and `BoardModel`) is Y-down. Every emitted
 *    Y is negated, and every parsed Y is negated back. {@link dsnY}/{@link mmY}.
 * 3. **Padstacks.** Specctra pins reference a named padstack defined in the
 *    library; an inline shape is not legal. {@link buildPadstacks} interns one
 *    padstack per distinct pad geometry.
 *
 * The SES side mirrors Freerouting's own writer (`SesWriter.java`): wires live
 * under `(routes (network_out (net "N" (wire (path <layer> <width> x y …)) …)))`,
 * a path names its layer *before* its width, and a via names a padstack rather
 * than carrying its own geometry.
 *
 * End-to-end acceptance by a real jar is proven only by the gated integration
 * test (`COPPERHEAD_TEST_FREEROUTING_JAR`); the unit tests pin the grammar
 * against a captured Freerouting-shaped session rather than against this
 * parser's own output.
 */

import { parseSexp, isList, children, child, type SexpNode } from '../sexp.js';
import type { BoardModel, DesignRules, Pad, PlacedFootprint, RoutedBoard, Track, Via } from './types.js';

/** Unit named in the `(resolution …)`/`(unit …)` records — coordinates are in this. */
export const DSN_UNIT = 'um';
/**
 * Granularity stated in `(resolution um 10)`: 0.1 um. Declared for KiCad parity;
 * coordinates themselves are whole micrometres, which is ~0.5 um of rounding at
 * worst — three orders of magnitude below any clearance rule.
 */
export const DSN_RESOLUTION = 10;

/** DSN units per millimetre (coordinates are micrometres). */
export const DSN_UNITS_PER_MM = 1000;

/** Millimetres → DSN units (integer micrometres). */
export function mmToDsn(mm: number): number {
  return Math.round(mm * DSN_UNITS_PER_MM);
}

/** DSN units → millimetres, honouring whatever resolution the file declared. */
export function dsnToMm(units: number, unitsPerMm: number = DSN_UNITS_PER_MM): number {
  return units / unitsPerMm;
}

/** Board-space Y (mm, Y-down) → DSN Y (units, Y-up). */
export function dsnY(mm: number): number {
  return -mmToDsn(mm);
}

/** DSN Y (units, Y-up) → board-space Y (mm, Y-down). */
export function mmY(units: number, unitsPerMm: number = DSN_UNITS_PER_MM): number {
  return -dsnToMm(units, unitsPerMm);
}

/** Millimetres per unit for the units Specctra's `(resolution …)` can name. */
const UNIT_MM: Record<string, number> = { inch: 25.4, mil: 0.0254, um: 0.001, mm: 1, cm: 10 };

/** Raised when a session file is present but not intelligible as Specctra SES. */
export class SesParseError extends Error {
  constructor(message: string) {
    super(`malformed Specctra session (.ses): ${message}`);
    this.name = 'SesParseError';
  }
}

/** Quote a token for a `(string_quote ")` + `(space_in_quoted_tokens on)` file. */
const q = (s: string): string => `"${s.replace(/"/g, '')}"`;

/** A single line of s-expression output, indented by depth. */
class SexpWriter {
  private lines: string[] = [];

  line(depth: number, text: string): this {
    this.lines.push(`${'  '.repeat(depth)}${text}`);
    return this;
  }

  open(depth: number, tag: string): this {
    return this.line(depth, `(${tag}`);
  }

  close(depth: number): this {
    return this.line(depth, ')');
  }

  toString(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

/** A padstack: the named, reusable copper geometry a `(pin …)` refers to. */
interface Padstack {
  name: string;
  kind: 'circle' | 'rect';
  /** Copper layers the padstack lands on, already resolved for the board side. */
  layers: string[];
  /** Diameter (circle) or width/height (rect), in mm. */
  width: number;
  height: number;
}

/**
 * Integer micrometres, for padstack names (KiCad's own naming convention).
 * Identical to {@link mmToDsn} by construction — the name and the shape value
 * agree in KiCad's export (`Round[A]Pad_1200_um` → `(circle F.Cu 1200)`), and
 * they must keep agreeing here.
 */
const um = mmToDsn;

/**
 * Copper layers a pad occupies, resolved for the side its footprint sits on.
 * `*.Cu` (and an explicit F+B pair) means a through-hole pad; a bare `F.Cu` on a
 * back-side footprint is really `B.Cu` once the footprint is flipped.
 */
function padLayers(pad: Pad, side: 'front' | 'back'): string[] {
  const raw = pad.layers.length ? pad.layers : ['F.Cu'];
  const through = raw.some((l) => l === '*.Cu') || (raw.includes('F.Cu') && raw.includes('B.Cu'));
  if (through) return ['F.Cu', 'B.Cu'];
  const front = raw.includes('F.Cu');
  const onFront = side === 'back' ? !front : front;
  return [onFront ? 'F.Cu' : 'B.Cu'];
}

/** Layer tag in a padstack name: all layers, top only, bottom only. */
const layerTag = (layers: string[]): string => (layers.length > 1 ? 'A' : layers[0] === 'B.Cu' ? 'B' : 'T');

/**
 * Pad geometry as a padstack. Rotation is baked into the dimensions for the
 * quarter turns that actually occur in footprint libraries, so the padstack
 * stays an axis-aligned shape and no `(rotate …)` record is needed.
 */
function padstackFor(pad: Pad, side: 'front' | 'back'): Padstack {
  const layers = padLayers(pad, side);
  const rot = ((pad.rot ?? 0) % 360 + 360) % 360;
  const quarter = rot === 90 || rot === 270;
  const width = quarter ? pad.height : pad.width;
  const height = quarter ? pad.width : pad.height;
  const shape = pad.shape ?? 'rect';
  const round = (shape === 'circle' || shape === 'oval') && Math.abs(width - height) < 1e-9;
  const tag = layerTag(layers);
  return round
    ? { name: `Round[${tag}]Pad_${um(width)}_um`, kind: 'circle', layers, width, height: width }
    : { name: `Rect[${tag}]Pad_${um(width)}x${um(height)}_um`, kind: 'rect', layers, width, height };
}

/** Via padstack name, encoding diameter and drill the way KiCad's exporter does. */
export function viaPadstackName(rules: DesignRules): string {
  return `Via[0-1]_${um(rules.viaDiameter)}:${um(rules.viaDrill)}_um`;
}

/**
 * Intern one padstack per distinct pad geometry across the whole board, keyed by
 * generated name. Deterministic: insertion order follows footprint then pad order.
 */
function buildPadstacks(board: BoardModel): { byPad: Map<string, string>; stacks: Padstack[] } {
  const byPad = new Map<string, string>();
  const stacks = new Map<string, Padstack>();
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      const stack = padstackFor(pad, fp.side);
      if (!stacks.has(stack.name)) stacks.set(stack.name, stack);
      byPad.set(`${fp.ref}/${pad.number}`, stack.name);
    }
  }
  return { byPad, stacks: [...stacks.values()] };
}

function writePadstack(w: SexpWriter, depth: number, stack: Padstack): void {
  w.open(depth, `padstack ${q(stack.name)}`);
  for (const layer of stack.layers) {
    if (stack.kind === 'circle') {
      w.line(depth + 1, `(shape (circle ${layer} ${mmToDsn(stack.width)}))`);
    } else {
      const hw = mmToDsn(stack.width) / 2;
      const hh = mmToDsn(stack.height) / 2;
      w.line(depth + 1, `(shape (rect ${layer} ${-hw} ${-hh} ${hw} ${hh}))`);
    }
  }
  w.line(depth + 1, '(attach off)');
  w.close(depth);
}

export interface DsnEmitOptions {
  /** Board name used in the `(pcb …)` header. */
  boardName?: string;
}

/** Courtyard outline, or a small default box when the footprint has none drawn. */
function outlineOf(fp: PlacedFootprint): { minX: number; minY: number; maxX: number; maxY: number } {
  if (fp.courtyard) return fp.courtyard;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of fp.pads) {
    minX = Math.min(minX, p.x - p.width / 2);
    maxX = Math.max(maxX, p.x + p.width / 2);
    minY = Math.min(minY, p.y - p.height / 2);
    maxY = Math.max(maxY, p.y + p.height / 2);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 };
}

/**
 * Emit a Specctra Design (`.dsn`) for a placed board. The board must already be
 * placed (footprints carry absolute `x`/`y`); `(wiring)` is emitted empty — a DSN
 * is the *unrouted* input to an autorouter.
 *
 * One image is emitted per component rather than per library footprint. That is
 * legal Specctra and keeps the emitter a pure function of `BoardModel`, which
 * carries per-instance pad geometry and no library identity to dedupe on.
 */
export function emitDsn(board: BoardModel, rules: DesignRules, opts: DsnEmitOptions = {}): string {
  const w = new SexpWriter();
  const name = opts.boardName ?? 'board';
  const { byPad, stacks } = buildPadstacks(board);
  const viaName = viaPadstackName(rules);

  w.open(0, `pcb ${q(name)}`);
  // `(space_in_quoted_tokens on)` lets net names contain spaces (e.g. a hand-named
  // `"VCC 3V3"`), which KiCad's own exporter also enables. The `(string_quote ")`
  // directive KiCad emits is omitted: it only re-states the default quote char and
  // would break this repo's own s-expression reader, which treats `"` as its
  // delimiter. The default quote (`"`) plus space-in-quotes is the effective config.
  w.open(1, 'parser');
  w.line(2, '(space_in_quoted_tokens on)');
  w.line(2, '(host_cad "copperhead")');
  w.close(1);
  w.line(1, `(resolution ${DSN_UNIT} ${DSN_RESOLUTION})`);
  w.line(1, `(unit ${DSN_UNIT})`);

  w.open(1, 'structure');
  w.open(2, 'layer F.Cu');
  w.line(3, '(type signal)');
  w.line(3, '(property (index 0))');
  w.close(2);
  w.open(2, 'layer B.Cu');
  w.line(3, '(type signal)');
  w.line(3, '(property (index 1))');
  w.close(2);
  // Board outline, Y-flipped: the board occupies y in [-height, 0].
  const bw = mmToDsn(board.width);
  const bh = mmToDsn(board.height);
  w.open(2, 'boundary');
  w.line(3, `(path pcb 0  0 0  ${bw} 0  ${bw} ${-bh}  0 ${-bh}  0 0)`);
  w.close(2);
  w.line(2, `(via ${q(viaName)})`);
  w.open(2, 'rule');
  w.line(3, `(width ${mmToDsn(rules.trackWidth)})`);
  w.line(3, `(clearance ${mmToDsn(rules.clearance)})`);
  w.line(3, `(clearance ${mmToDsn(rules.clearance)} (type default_smd))`);
  w.line(3, `(clearance ${mmToDsn(rules.clearance)} (type smd_smd))`);
  w.close(2);
  w.close(1);

  w.open(1, 'placement');
  for (const fp of board.footprints) {
    w.open(2, `component ${fp.ref}`);
    // (place <refdes> <x> <y> <side> <rotation>) — refdes first, side after the
    // coordinates, and the refdes unquoted so it matches the `(pins U1-1 …)`
    // net references. Getting this order wrong silently mislocates every part.
    const rot = ((Math.round(fp.rotation) % 360) + 360) % 360;
    w.line(3, `(place ${fp.ref} ${mmToDsn(fp.x)} ${dsnY(fp.y)} ${fp.side} ${rot})`);
    w.close(2);
  }
  w.close(1);

  w.open(1, 'library');
  for (const fp of board.footprints) {
    w.open(2, `image ${fp.ref}`);
    const o = outlineOf(fp);
    const x1 = mmToDsn(o.minX);
    const x2 = mmToDsn(o.maxX);
    // Y-flip swaps which extent is the larger value.
    const y1 = dsnY(o.maxY);
    const y2 = dsnY(o.minY);
    w.line(3, `(outline (path signal 0  ${x1} ${y1}  ${x2} ${y1}  ${x2} ${y2}  ${x1} ${y2}  ${x1} ${y1}))`);
    for (const pad of fp.pads) {
      const stack = byPad.get(`${fp.ref}/${pad.number}`)!;
      // (pin <padstack_name> <pin_id> <x> <y>) — the padstack is referenced by
      // name; an inline shape here is not legal Specctra.
      w.line(3, `(pin ${q(stack)} ${q(pad.number)} ${mmToDsn(pad.x)} ${dsnY(pad.y)})`);
    }
    w.close(2);
  }
  for (const stack of stacks) writePadstack(w, 2, stack);
  writePadstack(w, 2, {
    name: viaName,
    kind: 'circle',
    layers: ['F.Cu', 'B.Cu'],
    width: rules.viaDiameter,
    height: rules.viaDiameter,
  });
  w.close(1);

  w.open(1, 'network');
  for (const net of board.nets) {
    w.open(2, `net ${q(net.name)}`);
    w.line(3, `(pins ${net.pins.map((p) => `${p.ref}-${p.pad}`).join(' ')})`);
    w.close(2);
  }
  // Every net needs a class, or the router has no width/clearance/via rule to
  // apply to it.
  w.open(2, `class kicad_default ${board.nets.map((n) => q(n.name)).join(' ')}`);
  w.line(3, `(circuit (use_via ${q(viaName)}))`);
  w.line(3, `(rule (width ${mmToDsn(rules.trackWidth)}) (clearance ${mmToDsn(rules.clearance)}))`);
  w.close(2);
  w.close(1);

  w.open(1, 'wiring');
  w.close(1);

  w.close(0);
  return w.toString();
}

const asString = (n: SexpNode | undefined): string | undefined => (typeof n === 'string' ? n : undefined);

function numberAt(list: SexpNode[], index: number, what: string): number {
  const v = list[index];
  if (typeof v !== 'string') throw new SesParseError(`expected a number for ${what}`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new SesParseError(`expected a number for ${what}, got "${v}"`);
  return n;
}

/** Depth-first walk of every list node in a parsed s-expression tree. */
function* walkLists(node: SexpNode): Generator<SexpNode[]> {
  if (isList(node)) {
    yield node;
    for (const n of node) yield* walkLists(n);
  }
}

/** First list node with the given head, anywhere in the tree. */
function findScope(root: SexpNode, head: string): SexpNode[] | undefined {
  for (const node of walkLists(root)) if (node[0] === head) return node;
  return undefined;
}

/**
 * DSN units per millimetre for a `(resolution <unit> <value>)` record. The unit
 * name sets the scale; `<value>` is granularity, not a divisor (see the module
 * header). Session files echo the design's resolution and a router may echo a
 * different unit, so this is read rather than assumed.
 */
function unitsPerMmOf(root: SexpNode): number {
  const res = findScope(root, 'resolution');
  const unit = res ? asString(res[1]) : undefined;
  const mmPerUnit = unit ? UNIT_MM[unit] : undefined;
  return mmPerUnit === undefined ? DSN_UNITS_PER_MM : 1 / mmPerUnit;
}

/** Via geometry recovered from `library_out`, keyed by padstack name. */
interface ViaStack {
  diameter: number;
  drill?: number;
}

/**
 * Read via geometry out of the session's `library_out`. The copper diameter is
 * the circle shape; the drill is not carried in SES at all, so it is recovered
 * from KiCad's `Via[0-1]_<diameter>:<drill>_um` name when present and left to the
 * caller's design rules otherwise.
 */
function parseViaStacks(root: SexpNode, unitsPerMm: number): Map<string, ViaStack> {
  const out = new Map<string, ViaStack>();
  const lib = findScope(root, 'library_out');
  if (!lib) return out;
  for (const stack of children(lib, 'padstack')) {
    const name = asString(stack[1]);
    if (!name) continue;
    let diameter = 0;
    for (const shape of children(stack, 'shape')) {
      const circle = child(shape, 'circle');
      if (!circle) continue;
      const d = Number(asString(circle[2]));
      if (Number.isFinite(d)) diameter = Math.max(diameter, dsnToMm(d, unitsPerMm));
    }
    const named = /_(\d+):(\d+)_um/.exec(name);
    out.set(name, {
      diameter: diameter || (named ? Number(named[1]) / 1000 : 0),
      ...(named ? { drill: Number(named[2]) / 1000 } : {}),
    });
  }
  return out;
}

export interface SesParseOptions {
  /** Design rules used to fill in geometry the session does not carry (via drill). */
  rules?: DesignRules;
}

/**
 * Parse a Specctra Session (`.ses`) written back by an autorouter into tracks and
 * vias, in `BoardModel` millimetres and Y-down board space.
 *
 * Shape (Freerouting's `SesWriter`):
 * ```
 * (session "x.ses"
 *   (routes
 *     (resolution um 10)
 *     (library_out (padstack "Via[0-1]_600:300_um" (shape (circle F.Cu 6000)) …))
 *     (network_out
 *       (net "GND"
 *         (wire (path F.Cu 2500  10000 -20000  30000 -20000) (type protect))
 *         (via "Via[0-1]_600:300_um" 30000 -20000)))))
 * ```
 * A path names its **layer before its width**, and that layer is carried through
 * onto the `Track` — collapsing it to F.Cu would turn a two-layer route into a
 * pile of shorts.
 */
export function parseSes(text: string, opts: SesParseOptions = {}): RoutedBoard {
  const tree = parseSexp(text);
  const session = tree.find(isList);
  if (!session) throw new SesParseError('no s-expression content');
  if (session[0] !== 'session') throw new SesParseError(`expected a (session …) scope, got "${String(session[0])}"`);

  const unitsPerMm = unitsPerMmOf(findScope(session, 'routes') ?? session);
  const viaStacks = parseViaStacks(session, unitsPerMm);

  const tracks: Track[] = [];
  const vias: Via[] = [];

  // Wires and vias live under (network_out (net "NAME" …)). Fall back to the
  // whole session so a router that omits network_out still parses.
  const scope = findScope(session, 'network_out') ?? session;
  for (const net of walkLists(scope)) {
    if (net[0] !== 'net') continue;
    const netName = asString(net[1]);
    if (netName === undefined) continue;

    for (const wire of children(net, 'wire')) {
      const pathList = child(wire, 'path');
      if (!pathList) continue;
      const layer = asString(pathList[1]);
      if (layer === undefined) throw new SesParseError(`wire path on net "${netName}" has no layer`);
      const width = dsnToMm(numberAt(pathList, 2, `width of a wire on net "${netName}"`), unitsPerMm);
      const coords = pathList.slice(3);
      if (coords.length < 4 || coords.length % 2 !== 0) {
        throw new SesParseError(`wire path on net "${netName}" has ${coords.length} coordinate(s)`);
      }
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < coords.length; i += 2) {
        points.push({
          x: dsnToMm(numberAt(coords, i, `a wire coordinate on net "${netName}"`), unitsPerMm),
          y: mmY(numberAt(coords, i + 1, `a wire coordinate on net "${netName}"`), unitsPerMm),
        });
      }
      tracks.push({ net: netName, layer, width, points });
    }

    for (const via of children(net, 'via')) {
      // (via <padstack_name> <x> <y>) — the padstack is a *name*, not a number.
      const stackName = asString(via[1]);
      if (stackName === undefined) throw new SesParseError(`via on net "${netName}" has no padstack name`);
      const stack = viaStacks.get(stackName);
      vias.push({
        net: netName,
        x: dsnToMm(numberAt(via, 2, `via x on net "${netName}"`), unitsPerMm),
        y: mmY(numberAt(via, 3, `via y on net "${netName}"`), unitsPerMm),
        diameter: stack?.diameter || opts.rules?.viaDiameter || 0,
        drill: stack?.drill ?? opts.rules?.viaDrill ?? 0,
      });
    }
  }

  return { tracks, vias };
}

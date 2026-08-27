/**
 * Specctra DSN/SES bridge (issue #252): emit a Design (`.dsn`) the autorouters
 * consume, and read the Session (`.ses`) they write back. No `kicad-cli`
 * Specctra export exists, so this is copperhead's own bridge, kept single-language
 * and CI-portable.
 *
 * Coordinate convention (the issue's care point): `BoardModel` is millimeters;
 * on the wire the bridge pins **mils with integer coordinates** (`(unit mil)`,
 * `(resolution mil 100)`), the de-facto default KiCad and Freerouting agree on.
 * `mmToMil`/`milToMm` are the single conversion point, so a unit mismatch can
 * never scale or rotate a board silently — both sides go through them.
 *
 * The exact DSN/SES grammar Freerouting accepts is validated in the gated
 * integration test (`COPPERHEAD_TEST_FREEROUTING_JAR`); the unit tests here pin
 * well-formed s-expressions, determinism, and DSN↔SES round-trip consistency.
 */

import { parseSexp, isList, children, child, type SexpNode } from '../sexp.js';
import type { BoardModel, DesignRules, RoutedBoard, Track, Via } from './types.js';

/** mils per millimeter. */
export const MILS_PER_MM = 1 / 0.0254;

export function mmToMil(mm: number): number {
  return Math.round(mm * MILS_PER_MM);
}

export function milToMm(mil: number): number {
  return mil / MILS_PER_MM;
}

export interface DsnEmitOptions {
  /** Board name used in the `(pcb …)` header and `host_cad` stamp. */
  boardName?: string;
}

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

function padShape(pad: { width: number; height: number }): string {
  if (Math.abs(pad.width - pad.height) < 1e-9) return `(circle ${mmToMil(pad.width)})`;
  // A very elongated pad is an oval; otherwise a rect. Rounded-rect pads are not
  // representable in classic Specctra, so they collapse to rect here.
  return `(rect ${mmToMil(pad.width)} ${mmToMil(pad.height)})`;
}

/**
 * Emit a Specctra Design (`.dsn`) for a placed board. The board must already be
 * placed (footprints carry absolute `x`/`y`); wiring is emitted empty — a DSN is
 * the *unrouted* input to an autorouter.
 */
export function emitDsn(board: BoardModel, rules: DesignRules, opts: DsnEmitOptions = {}): string {
  const w = new SexpWriter();
  const name = opts.boardName ?? 'board';

  w.open(0, `pcb "${name}"`);
  w.open(1, 'parser');
  w.line(2, '(string_quote ")');
  w.line(2, '(space_in_quoted_tokens on)');
  w.line(2, '(host_cad "copperhead")');
  w.close(1);
  w.line(1, '(resolution mil 100)');
  w.line(1, '(unit mil)');

  w.open(1, 'structure');
  w.open(2, 'layer F.Cu');
  w.line(3, '(type signal)');
  w.close(2);
  w.open(2, 'layer B.Cu');
  w.line(3, '(type signal)');
  w.close(2);
  w.open(2, 'boundary');
  w.line(3, `(rect 0 0 ${mmToMil(board.width)} ${mmToMil(board.height)})`);
  w.close(2);
  w.open(2, 'via VIA');
  w.line(3, `(diameter ${mmToMil(rules.viaDiameter)})`);
  w.line(3, `(drill ${mmToMil(rules.viaDrill)})`);
  w.close(2);
  w.open(2, 'rule');
  w.line(3, `(width ${mmToMil(rules.trackWidth)})`);
  w.line(3, `(clearance ${mmToMil(rules.clearance)})`);
  w.close(2);
  w.close(1);

  w.open(1, 'placement');
  for (const fp of board.footprints) {
    w.open(2, `component ${fp.ref}`);
    w.line(3, `(place ${fp.side} ${mmToMil(fp.x)} ${mmToMil(fp.y)} ${Math.round(fp.rotation)} none)`);
    w.close(2);
  }
  w.close(1);

  w.open(1, 'library');
  for (const fp of board.footprints) {
    w.open(2, `image ${fp.ref}`);
    if (fp.courtyard) {
      const hw = fp.courtyard.width / 2;
      const hh = fp.courtyard.height / 2;
      w.line(3, `(outline (rect ${mmToMil(-hw)} ${mmToMil(-hh)} ${mmToMil(hw)} ${mmToMil(hh)}))`);
    }
    for (const pad of fp.pads) {
      // Pad coordinates are footprint-local; the image uses them as-is, and the
      // `placement` `(place x y …)` carries the absolute origin that positions them.
      w.line(3, `(pin ${pad.number} ${padShape(pad)} ${mmToMil(pad.x)} ${mmToMil(pad.y)} 0)`);
    }
    w.close(2);
  }
  w.close(1);

  w.open(1, 'network');
  for (const net of board.nets) {
    w.open(2, `net "${net.name}"`);
    w.line(3, `(pins ${net.pins.map((p) => `${p.ref}-${p.pad}`).join(' ')})`);
    w.close(2);
  }
  w.close(1);

  w.open(1, 'wiring');
  w.close(1);

  w.close(0);
  return w.toString();
}

function numAt(list: SexpNode[], index: number): number {
  const v = list[index];
  if (typeof v !== 'string') throw new Error(`expected a number at index ${index} of ${JSON.stringify(list)}`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${JSON.stringify(v)}`);
  return n;
}

function strAt(list: SexpNode[], index: number): string {
  const v = list[index];
  if (typeof v !== 'string') throw new Error(`expected a string at index ${index}`);
  return v;
}

/**
 * Parse a Specctra Session (`.ses`) written back by an autorouter into tracks and
 * vias. Assumes Freerouting's shape: `(session … (route <net> (wire (path x y …)
 * (width w)) (via x y (diam d) (drill d)) …) …)`. Coordinates come back through
 * `milToMm`, the inverse of {@link emitDsn}.
 */
/** Depth-first walk of every list node in a parsed s-expression tree. */
function* walkLists(node: SexpNode): Generator<SexpNode[]> {
  if (isList(node)) {
    yield node;
    for (const n of node) yield* walkLists(n);
  }
}

export function parseSes(text: string): RoutedBoard {
  const tree = parseSexp(text);
  const session = tree.find(isList);
  if (!session) return { tracks: [], vias: [] };

  const tracks: Track[] = [];
  const vias: Via[] = [];

  // `route` nodes may sit directly under `session` or nested under `routes`.
  for (const route of walkLists(session)) {
    if (route[0] !== 'route') continue;
    const net = strAt(route, 1);
    for (const wire of children(route, 'wire')) {
      const pathList = child(wire, 'path');
      if (!pathList) continue;
      const raw = pathList.slice(1).map((n) => Number(n));
      if (raw.length < 4 || raw.some((n) => !Number.isFinite(n))) continue;
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i + 1 < raw.length; i += 2) points.push({ x: milToMm(raw[i]!), y: milToMm(raw[i + 1]!) });
      const widthList = child(wire, 'width');
      const width = widthList ? numAt(widthList, 1) : 0;
      tracks.push({ net, layer: 'F.Cu', width: milToMm(width), points });
    }
    for (const via of children(route, 'via')) {
      const x = numAt(via, 1);
      const y = numAt(via, 2);
      const diamList = child(via, 'diam');
      const drillList = child(via, 'drill');
      vias.push({
        net,
        x: milToMm(x),
        y: milToMm(y),
        diameter: milToMm(diamList ? numAt(diamList, 1) : 0),
        drill: milToMm(drillList ? numAt(drillList, 1) : 0),
      });
    }
  }

  return { tracks, vias };
}

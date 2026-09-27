import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSexp, children, child, isList, type SexpNode } from './sexp.js';
import { childSpans, listEnd, type Span } from './spans.js';
import { exportNetlist, kicadLoadError } from './cli.js';
import { uuidv5 } from './emit.js';
import {
  FootprintResolver,
  formatPadMismatch,
  missingFootprints,
  padNumbers,
  type MissingFootprint,
  type PadMismatch,
} from './footprints.js';

/**
 * Board populate for the layout-draft stage (#314): the deterministic step
 * between a verified schematic and an agent that places parts. It reads the
 * schematic's KiCad netlist, resolves every part's exact footprint, copies
 * each `.kicad_mod` onto the board with anchored text edits (refdes, value,
 * uuid, position, schematic link, pad nets — never regenerated geometry),
 * packs them on a grid inside the outline, and writes the board only after
 * KiCad loads the result. Any unresolved part aborts before a byte is written.
 *
 * The s-expression parser stays read-only (SPEC §1.3): it is used to read the
 * netlist, board, and footprint bounds; every write is a splice of original
 * source text.
 */

export interface NetlistPart {
  ref: string;
  value: string;
  footprint: string;
  /** Schematic symbol path, `/<sheet uuids…>/<symbol uuid>`. */
  path: string;
  sheetname: string;
  sheetfile: string;
}

export interface Netlist {
  parts: NetlistPart[];
  /** net name → [ref, pin] endpoints. */
  nets: Map<string, [string, string][]>;
}

const atom = (node: SexpNode[] | undefined, idx: number): string | undefined => {
  const v = node?.[idx];
  return typeof v === 'string' ? v : undefined;
};

// Orderings that decide net codes and placement must not follow the process
// locale, or two machines would write different boards from one schematic
// (AC-15.37): a fixed collation for refdes and pad numbers, code units for
// net names.
const collator = new Intl.Collator('en', { numeric: true });
const byRef = (a: string, b: string): number => collator.compare(a, b);
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Board-bound parts and nets from a kicadsexpr netlist. */
export function parseNetlist(text: string): Netlist {
  const root = parseSexp(text)[0];
  const parts: NetlistPart[] = [];
  const nets = new Map<string, [string, string][]>();
  if (!root || !isList(root)) return { parts, nets };
  for (const comp of children(child(root, 'components') ?? [], 'comp')) {
    const ref = atom(child(comp, 'ref'), 1) ?? '';
    // power flags and other virtual symbols carry `#` refs and never reach a board
    if (!ref || ref.startsWith('#')) continue;
    const props = new Map<string, string>();
    for (const p of children(comp, 'property')) {
      const name = atom(child(p, 'name'), 1);
      if (name) props.set(name, atom(child(p, 'value'), 1) ?? '');
    }
    if (props.has('exclude_from_board')) continue;
    const sheetTstamps = atom(child(child(comp, 'sheetpath') ?? [], 'tstamps'), 1) ?? '/';
    const tstamp = atom(child(comp, 'tstamps'), 1) ?? atom(child(comp, 'tstamp'), 1) ?? '';
    parts.push({
      ref,
      value: atom(child(comp, 'value'), 1) ?? '',
      footprint: atom(child(comp, 'footprint'), 1) ?? '',
      path: `${sheetTstamps.endsWith('/') ? sheetTstamps : sheetTstamps + '/'}${tstamp}`,
      sheetname: props.get('Sheetname') ?? '',
      sheetfile: props.get('Sheetfile') ?? '',
    });
  }
  const boardRefs = new Set(parts.map((p) => p.ref));
  for (const net of children(child(root, 'nets') ?? [], 'net')) {
    const name = atom(child(net, 'name'), 1);
    if (!name) continue;
    const nodes: [string, string][] = [];
    for (const n of children(net, 'node')) {
      const ref = atom(child(n, 'ref'), 1);
      const pin = atom(child(n, 'pin'), 1);
      if (ref && pin && boardRefs.has(ref)) nodes.push([ref, pin]);
    }
    if (nodes.length) nets.set(name, nodes);
  }
  parts.sort((a, b) => byRef(a.ref, b.ref));
  return { parts, nets };
}

/** A point turned by `deg` as KiCad turns a footprint: Y down, positive is counterclockwise on screen. */
function rotate(x: number, y: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c + y * s, -x * s + y * c];
}

/**
 * A board stores a footprint's own zones (an ESP32 module's antenna keepout)
 * in board coordinates, unlike its pads and graphics, so they must move with
 * the part: every point p becomes `to + rotate(p - from, delta)`. Left at the
 * library's origin, the zone makes KiCad report the footprint as modified.
 */
function moveZonePoints(zoneText: string, from: { x: number; y: number }, to: { x: number; y: number }, delta: number): string {
  return zoneText.replace(/\((xy|start|mid|end)\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g, (_, k: string, xs: string, ys: string) => {
    const [rx, ry] = rotate(Number(xs) - from.x, Number(ys) - from.y, delta);
    // KiCad's own resolution (1 nm): a coarser point reads as an edited zone
    const nm = (n: number): string => String(Math.round(n * 1e6) / 1e6);
    return `(${k} ${nm(to.x + rx)} ${nm(to.y + ry)})`;
  });
}

const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
const num = (n: number): string => String(Math.round(n * 1e4) / 1e4);

// ---- footprint geometry -----------------------------------------------------

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Everything the footprint draws: pads, graphics on every layer (courtyard
 * included), and visible silkscreen text sized by the instance's own refdes
 * and value, so a packed neighbour or the board edge never clips its silk.
 */
export function footprintBounds(modText: string, labels: { ref?: string; value?: string } = {}): Bounds {
  const root = parseSexp(modText)[0];
  const all: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (b: Bounds, x: number, y: number): void => {
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  };
  const xy = (n: SexpNode[] | undefined): [number, number] | null =>
    n ? [parseFloat(atom(n, 1) ?? 'NaN'), parseFloat(atom(n, 2) ?? 'NaN')] : null;
  if (!root || !isList(root)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  for (const item of root) {
    if (!isList(item)) continue;
    const tag = item[0];
    if (tag === 'pad') {
      const at = xy(child(item, 'at'));
      const size = xy(child(item, 'size'));
      if (!at || !size) continue;
      const r = Math.max(size[0], size[1]) / 2; // rotation-safe
      grow(all, at[0] - r, at[1] - r);
      grow(all, at[0] + r, at[1] + r);
      continue;
    }
    if (tag === 'property' || tag === 'fp_text') {
      const hidden = atom(child(item, 'hide'), 1) === 'yes' || item.includes('hide') || child(child(item, 'effects') ?? [], 'hide');
      const at = xy(child(item, 'at'));
      const size = xy(child(child(child(item, 'effects') ?? [], 'font') ?? [], 'size'));
      const layer = atom(child(item, 'layer'), 1) ?? '';
      const kind = (atom(item, 1) ?? '').toLowerCase();
      const label = kind === 'reference' ? (labels.ref ?? atom(item, 2)) : kind === 'value' ? (labels.value ?? atom(item, 2)) : atom(item, 2);
      if (hidden || !at || !size || !label || !layer.endsWith('.SilkS')) continue;
      // a rough box: KiCad's stroke font is about 0.8 x height per glyph
      const half = { w: (label.length * size[0] * 0.8) / 2, h: size[1] / 2 };
      grow(all, at[0] - half.w, at[1] - half.h);
      grow(all, at[0] + half.w, at[1] + half.h);
      continue;
    }
    if (typeof tag !== 'string' || !/^fp_(line|rect|circle|arc|poly)$/.test(tag)) continue;
    const pts: [number, number][] = [];
    for (const k of ['start', 'mid', 'end']) {
      const p = xy(child(item, k));
      if (p) pts.push(p);
    }
    for (const p of children(child(item, 'pts') ?? [], 'xy')) {
      const v = xy(p);
      if (v) pts.push(v);
    }
    const center = xy(child(item, 'center'));
    if (tag === 'fp_circle' && center && pts[0]) {
      const r = Math.hypot(pts[0][0] - center[0], pts[0][1] - center[1]);
      pts.push([center[0] - r, center[1] - r], [center[0] + r, center[1] + r]);
    }
    for (const [x, y] of pts) if (Number.isFinite(x) && Number.isFinite(y)) grow(all, x, y);
  }
  return Number.isFinite(all.minX) ? all : { minX: -1, minY: -1, maxX: 1, maxY: 1 };
}

// ---- instantiation ----------------------------------------------------------

export interface Instance {
  fpId: string;
  ref: string;
  value: string;
  uuid: string;
  at: { x: number; y: number };
  path: string;
  sheetname: string;
  sheetfile: string;
  /** pad number → [net code, net name] */
  padNet: (pad: string) => [number, string] | undefined;
}

/**
 * A library `.kicad_mod` as a board footprint. Library-only header lines
 * (version, generator) are dropped; the id, refdes, value, uuid, placement,
 * schematic link, and pad nets are spliced into the original text. Pad and
 * graphic geometry is carried over byte-for-byte.
 */
export function instantiateFootprint(modText: string, inst: Instance): string {
  // KiCad 5 libraries (still common in vendor downloads) open with `(module`;
  // the head is rewritten either way, and KiCad's load probe vets the rest
  const open = /\((?:footprint|module)[\s"]/.exec(modText)?.index ?? -1;
  if (open < 0) throw new Error(`${inst.fpId}: not a footprint file`);
  const parts: string[] = [`(footprint ${q(inst.fpId)}`];
  let placed = false;
  const placement = [
    `(uuid ${q(inst.uuid)})`,
    `(at ${num(inst.at.x)} ${num(inst.at.y)})`,
  ];
  for (const s of childSpans(modText, open)) {
    let t = modText.slice(s.start, s.end);
    // library-only header lines, and the KiCad 5 edit timestamps (`tedit`,
    // `tstamp`) a board no longer carries
    if (['version', 'generator', 'generator_version', 'uuid', 'at', 'tedit', 'tstamp'].includes(s.tag)) continue;
    // Object ids inside the footprint (pads, graphics, zones; about a fifth of
    // the stock library carries them) must be unique on the board, and two
    // instances of one footprint would otherwise share every one. KiCad gives
    // a placed footprint fresh ids; these are derived from the instance's own
    // uuid and the library's id, so a re-populate still writes the same bytes.
    t = t
      .replace(/\(uuid\s+"([^"]+)"\)/g, (_, id: string) => `(uuid ${q(uuidv5(`${inst.uuid}/${id}`))})`)
      .replace(/\(tstamp\s+"?([0-9A-Fa-f-]+)"?\)/g, (_, id: string) => `(tstamp ${uuidv5(`${inst.uuid}/${id}`)})`);
    if (s.tag === 'property' || s.tag === 'fp_text') {
      // a KiCad 5 library writes the refdes and value unquoted (`REF**`)
      const token = '(?:"(?:[^"\\\\]|\\\\.)*"|[^\\s()"]+)';
      t = t
        .replace(new RegExp(`^\\(property\\s+"Reference"\\s+${token}`), `(property "Reference" ${q(inst.ref)}`)
        .replace(new RegExp(`^\\(property\\s+"Value"\\s+${token}`), `(property "Value" ${q(inst.value)}`)
        .replace(new RegExp(`^\\(fp_text\\s+reference\\s+${token}`), `(fp_text reference ${q(inst.ref)}`)
        .replace(new RegExp(`^\\(fp_text\\s+value\\s+${token}`), `(fp_text value ${q(inst.value)}`);
    } else if (s.tag === 'zone') {
      t = moveZonePoints(t, { x: 0, y: 0 }, inst.at, 0);
    } else if (s.tag === 'pad') {
      const pad = /^\(pad\s+"((?:[^"\\]|\\.)*)"/.exec(t)?.[1] ?? /^\(pad\s+([^\s()"]+)/.exec(t)?.[1] ?? '';
      const net = pad ? inst.padNet(pad) : undefined;
      if (net) {
        const close = t.lastIndexOf(')');
        t = `${t.slice(0, close).replace(/\s*$/, '')}\n\t\t(net ${net[0]} ${q(net[1])})\n\t)`;
      }
    }
    parts.push(t);
    if (s.tag === 'layer' && !placed) {
      parts.push(...placement);
      placed = true;
    }
  }
  if (!placed) parts.splice(1, 0, ...placement);
  parts.push(`(path ${q(inst.path)})`, `(sheetname ${q(inst.sheetname || '/')})`, `(sheetfile ${q(inst.sheetfile)})`);
  // library layout (children one tab in), then one more level as a board child
  const block = `${parts[0]}\n\t${parts.slice(1).join('\n\t')}\n)`;
  return block
    .split('\n')
    .map((l) => `\t${l}`)
    .join('\n');
}

// ---- the board --------------------------------------------------------------

/** Shelf-pack boxes into rows no wider than `width`; origins of each box. */
export function shelfPack(boxes: { w: number; h: number }[], width: number, gap: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > width) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    out.push({ x, y });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}

export interface PopulateResult {
  placed: { ref: string; footprint: string }[];
  nets: number;
  outline: { width: number; height: number; grown: boolean };
  /** True when the board already held exactly these footprints (no write). */
  unchanged: boolean;
}

export class PadMismatchError extends Error {
  constructor(readonly mismatches: PadMismatch[]) {
    super(
      `the schematic connects pins its footprints have no pad for, so those nets would vanish from the board:\n` +
        mismatches.map((m) => `  ${formatPadMismatch(m)}`).join('\n') +
        `\nFix the schematic (a symbol whose pin numbers match the footprint's pads, or the matching footprint in BOM.md and the intent), then re-run.`,
    );
  }
}

export class MissingFootprintsError extends Error {
  constructor(
    readonly missing: MissingFootprint[],
    readonly searched: string[],
  ) {
    super(`${missing.length} footprint(s) not installed: ${missing.map((m) => `${m.ref} ${m.footprint || '(none)'}`).join(', ')}`);
  }
}

/** (ref, footprint id) pairs of the footprints already on a board. */
export function boardFootprints(boardText: string): { ref: string; footprint: string }[] {
  const root = parseSexp(boardText)[0];
  if (!root || !isList(root)) return [];
  const out: { ref: string; footprint: string }[] = [];
  for (const fp of children(root, 'footprint')) {
    let ref = '';
    for (const p of children(fp, 'property')) if (atom(p, 1) === 'Reference') ref = atom(p, 2) ?? '';
    if (!ref) for (const t of children(fp, 'fp_text')) if (atom(t, 1) === 'reference') ref = atom(t, 2) ?? '';
    out.push({ ref, footprint: atom(fp, 1) ?? '' });
  }
  return out;
}

/** Every numbered pad on a board with its net name ('' for a pad on no net). */
export function boardPads(boardText: string): { ref: string; pad: string; net: string }[] {
  const root = parseSexp(boardText)[0];
  if (!root || !isList(root)) return [];
  const out: { ref: string; pad: string; net: string }[] = [];
  for (const fp of children(root, 'footprint')) {
    let ref = '';
    for (const p of children(fp, 'property')) if (atom(p, 1) === 'Reference') ref = atom(p, 2) ?? '';
    if (!ref) for (const t of children(fp, 'fp_text')) if (atom(t, 1) === 'reference') ref = atom(t, 2) ?? '';
    for (const pad of children(fp, 'pad')) {
      const n = atom(pad, 1);
      if (!n) continue;
      // `(net 3 "GND")`, or `(net "GND")` where a board omits net codes
      const net = child(pad, 'net');
      out.push({ ref, pad: n, net: (net && net.length >= 3 ? atom(net, 2) : atom(net, 1)) ?? '' });
    }
  }
  return out;
}

/**
 * Pads of the schematic's parts whose board net differs from the schematic
 * netlist (AC-15.38): a renamed or reassigned pad net, or a board populated
 * before the schematic was rewired. Each reads "R1.2 (VCC, schematic GND)".
 */
export function padNetMismatches(boardText: string, netlist: Netlist): string[] {
  const want = new Map<string, string>();
  for (const [name, nodes] of netlist.nets) for (const [ref, pin] of nodes) want.set(`${ref}\0${pin}`, name);
  const refs = new Set(netlist.parts.map((p) => p.ref));
  const out = new Set<string>();
  for (const p of boardPads(boardText)) {
    if (!refs.has(p.ref)) continue;
    const w = want.get(`${p.ref}\0${p.pad}`) ?? '';
    if (p.net !== w) out.add(`${p.ref}.${p.pad} (${p.net || 'no net'}, schematic ${w || 'no net'})`);
  }
  return [...out];
}

/** Do the board's (ref, footprint) pairs equal the netlist parts', exactly? */
export function boardMatchesNetlist(
  onBoard: { ref: string; footprint: string }[],
  parts: { ref: string; footprint: string }[],
): { ok: boolean; missing: string[]; extra: string[]; changed: string[] } {
  const want = new Map(parts.map((p) => [p.ref, p.footprint]));
  const have = new Map<string, string>();
  const extra: string[] = [];
  for (const f of onBoard) {
    if (!want.has(f.ref) || have.has(f.ref)) extra.push(f.ref || '(no ref)');
    else have.set(f.ref, f.footprint);
  }
  const missing = [...want.keys()].filter((r) => !have.has(r));
  const changed = [...have].filter(([r, fp]) => want.get(r) !== fp).map(([r, fp]) => `${r} (${fp}, schematic ${want.get(r)})`);
  return { ok: !missing.length && !extra.length && !changed.length, missing, extra, changed };
}

interface OutlineRect {
  start: number;
  end: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The board's outline when it is a single Edge.Cuts gr_rect (the scaffold's shape). */
function outlineRect(boardText: string, open: number): OutlineRect | null {
  const rects = childSpans(boardText, open).filter((s) => {
    if (s.tag !== 'gr_rect') return false;
    return /\(layer\s+"?Edge\.Cuts"?\)/.test(boardText.slice(s.start, s.end));
  });
  const edges = childSpans(boardText, open).filter(
    (s) => /^gr_(line|arc|circle|poly)$/.test(s.tag) && /\(layer\s+"?Edge\.Cuts"?\)/.test(boardText.slice(s.start, s.end)),
  );
  if (rects.length !== 1 || edges.length) return null;
  const t = boardText.slice(rects[0]!.start, rects[0]!.end);
  const s = /\(start\s+([-\d.]+)\s+([-\d.]+)\)/.exec(t);
  const e = /\(end\s+([-\d.]+)\s+([-\d.]+)\)/.exec(t);
  if (!s || !e) return null;
  const [a, b, c, d] = [s[1], s[2], e[1], e[2]].map(Number) as [number, number, number, number];
  return { start: rects[0]!.start, end: rects[0]!.end, x1: Math.min(a, c), y1: Math.min(b, d), x2: Math.max(a, c), y2: Math.max(b, d) };
}

/**
 * The box around every Edge.Cuts item, for an outline populate cannot resize
 * (rounded corners, mounting-hole cutouts, a polygon). Null without one.
 */
function outlineBox(boardText: string, open: number): Bounds | null {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of childSpans(boardText, open)) {
    if (!/^gr_(line|arc|circle|poly|rect)$/.test(s.tag)) continue;
    const t = boardText.slice(s.start, s.end);
    if (!/\(layer\s+"?Edge\.Cuts"?\)/.test(t)) continue;
    const pts = [...t.matchAll(/\((start|mid|end|center|xy)\s+([-\d.]+)\s+([-\d.]+)\)/g)].map((m) => ({
      k: m[1],
      x: Number(m[2]),
      y: Number(m[3]),
    }));
    const center = pts.find((p) => p.k === 'center');
    const end = pts.find((p) => p.k === 'end');
    if (s.tag === 'gr_circle' && center && end) {
      const r = Math.hypot(end.x - center.x, end.y - center.y);
      pts.push({ k: 'r', x: center.x - r, y: center.y - r }, { k: 'r', x: center.x + r, y: center.y + r });
    }
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      b.minX = Math.min(b.minX, p.x);
      b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x);
      b.maxY = Math.max(b.maxY, p.y);
    }
  }
  return Number.isFinite(b.minX) ? b : null;
}

type Segment = [number, number, number, number];

/**
 * Edge.Cuts as straight segments: lines, rectangles, polygons, arcs (sampled
 * through their midpoint), and circles (as 32-gons). Enough to tell whether a
 * packed part lies inside an outline populate cannot resize.
 */
function outlineSegments(boardText: string, open: number): Segment[] {
  const segs: Segment[] = [];
  const pt = (t: string, k: string): [number, number] | null => {
    const m = new RegExp(`\\(${k}\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\)`).exec(t);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const ring = (pts: [number, number][]): void => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      segs.push([a[0], a[1], b[0], b[1]]);
    }
  };
  for (const span of childSpans(boardText, open)) {
    if (!/^gr_(line|arc|circle|poly|rect)$/.test(span.tag)) continue;
    const t = boardText.slice(span.start, span.end);
    if (!/\(layer\s+"?Edge\.Cuts"?\)/.test(t)) continue;
    const start = pt(t, 'start');
    const end = pt(t, 'end');
    if (span.tag === 'gr_line' && start && end) segs.push([start[0], start[1], end[0], end[1]]);
    else if (span.tag === 'gr_rect' && start && end) {
      ring([start, [end[0], start[1]], end, [start[0], end[1]]]);
    } else if (span.tag === 'gr_circle') {
      const c = pt(t, 'center');
      if (!c || !end) continue;
      const r = Math.hypot(end[0] - c[0], end[1] - c[1]);
      ring(Array.from({ length: 32 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 16), c[1] + r * Math.sin((i * Math.PI) / 16)]));
    } else if (span.tag === 'gr_poly') {
      ring([...t.matchAll(/\(xy\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]));
    } else if (span.tag === 'gr_arc' && start && end) {
      const mid = pt(t, 'mid');
      if (!mid) {
        segs.push([start[0], start[1], end[0], end[1]]);
        continue;
      }
      // the circle through start, mid, end; sample from start to end through mid
      const [ax, ay] = start;
      const [bx, by] = mid;
      const [cx, cy] = end;
      const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(d) < 1e-9) {
        segs.push([ax, ay, bx, by], [bx, by, cx, cy]);
        continue;
      }
      const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
      const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
      const r = Math.hypot(ax - ux, ay - uy);
      const ang = (x: number, y: number): number => Math.atan2(y - uy, x - ux);
      const a0 = ang(ax, ay);
      let sweep = ang(cx, cy) - a0;
      let toMid = ang(bx, by) - a0;
      const norm = (v: number): number => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      sweep = norm(sweep);
      toMid = norm(toMid);
      if (toMid > sweep) sweep -= 2 * Math.PI; // mid lies the other way round
      const n = 16;
      let prev: [number, number] = [ax, ay];
      for (let i = 1; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        const next: [number, number] = i === n ? [cx, cy] : [ux + r * Math.cos(a), uy + r * Math.sin(a)];
        segs.push([prev[0], prev[1], next[0], next[1]]);
        prev = next;
      }
    }
  }
  return segs;
}

/** Even-odd: inside the outline (and outside any cutout it draws). */
function insideOutline(segs: Segment[], x: number, y: number): boolean {
  let inside = false;
  for (const [x1, y1, x2, y2] of segs) {
    if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
  }
  return inside;
}

/** Does any outline segment cross into the box? */
function outlineCrossesBox(segs: Segment[], b: Bounds): boolean {
  const inBox = (x: number, y: number): boolean => x > b.minX && x < b.maxX && y > b.minY && y < b.maxY;
  const cross = (p: Segment, q: Segment): boolean => {
    const o = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
      Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    return (
      o(p[0], p[1], p[2], p[3], q[0], q[1]) * o(p[0], p[1], p[2], p[3], q[2], q[3]) < 0 &&
      o(q[0], q[1], q[2], q[3], p[0], p[1]) * o(q[0], q[1], q[2], q[3], p[2], p[3]) < 0
    );
  };
  const edges: Segment[] = [
    [b.minX, b.minY, b.maxX, b.minY],
    [b.maxX, b.minY, b.maxX, b.maxY],
    [b.maxX, b.maxY, b.minX, b.maxY],
    [b.minX, b.maxY, b.minX, b.minY],
  ];
  return segs.some((s) => inBox(s[0], s[1]) || inBox(s[2], s[3]) || edges.some((e) => cross(s, e)));
}

const GAP = 1; // mm between courtyards
const MARGIN = 1; // mm from the outline

export interface PopulateOptions {
  repoRoot: string;
  schematic: string;
  board: string;
  resolver?: FootprintResolver;
  env?: NodeJS.ProcessEnv;
}

/**
 * Put every schematic part on the board with its exact footprint (AC-15.36).
 * All-or-nothing (AC-15.37): throws `MissingFootprintsError` or a load error
 * before writing anything, and leaves a board that already holds exactly the
 * schematic's footprints untouched.
 */
export async function populateBoard(opts: PopulateOptions): Promise<PopulateResult> {
  const schPath = path.join(opts.repoRoot, opts.schematic);
  const boardPath = path.join(opts.repoRoot, opts.board);
  const netlist = parseNetlist(await exportNetlist(schPath));
  const boardText = await readFile(boardPath, 'utf8');
  const onBoard = boardFootprints(boardText);
  if (onBoard.length) {
    const cmp = boardMatchesNetlist(onBoard, netlist.parts);
    const stale = cmp.ok ? padNetMismatches(boardText, netlist) : [];
    if (cmp.ok && !stale.length) {
      return { placed: [], nets: netlist.nets.size, outline: { width: 0, height: 0, grown: false }, unchanged: true };
    }
    if (cmp.ok) {
      throw new Error(
        `${opts.board} already has the schematic's footprints, but ${stale.length} pad net(s) differ from the schematic ` +
          `(${stale.slice(0, 8).join('; ')}${stale.length > 8 ? '; …' : ''}); populate fills an empty board only`,
      );
    }
    throw new Error(
      `${opts.board} already has footprints that do not match the schematic` +
        ` (missing: ${cmp.missing.join(', ') || 'none'}; extra: ${cmp.extra.join(', ') || 'none'}; changed: ${cmp.changed.join(', ') || 'none'});` +
        ' populate fills an empty board only',
    );
  }

  const resolver =
    opts.resolver ?? (await FootprintResolver.create({ projectDir: path.dirname(boardPath), ...(opts.env ? { env: opts.env } : {}) }));
  const missing = await missingFootprints(netlist.parts, resolver);
  if (missing.length) throw new MissingFootprintsError(missing, resolver.searched);

  // net codes: sorted by name, so the same schematic always numbers the same way
  const netNames = [...netlist.nets.keys()].sort(byCodeUnit);
  const code = new Map(netNames.map((n, i) => [n, i + 1]));
  const netOf = new Map<string, [number, string]>();
  for (const [name, nodes] of netlist.nets) for (const [ref, pin] of nodes) netOf.set(`${ref}\0${pin}`, [code.get(name)!, name]);

  const mods = new Map<string, { text: string }>();
  for (const p of netlist.parts) {
    if (mods.has(p.footprint)) continue;
    const r = await resolver.resolve(p.footprint);
    if (!r.ok) throw new MissingFootprintsError([{ ref: p.ref, footprint: p.footprint, why: r.why, near: r.near }], resolver.searched);
    const text = await readFile(r.file, 'utf8');
    mods.set(p.footprint, { text });
  }
  // every netlist pin must land on a pad, or its net silently drops off the board
  const pinsOf = new Map<string, Set<string>>();
  for (const nodes of netlist.nets.values())
    for (const [ref, pin] of nodes) {
      if (!pinsOf.has(ref)) pinsOf.set(ref, new Set());
      pinsOf.get(ref)!.add(pin);
    }
  const mismatches: PadMismatch[] = [];
  for (const p of netlist.parts) {
    const pads = padNumbers(mods.get(p.footprint)!.text);
    const pins = [...(pinsOf.get(p.ref) ?? [])].filter((pin) => !pads.has(pin));
    if (pins.length) {
      mismatches.push({ ref: p.ref, footprint: p.footprint, pins: pins.sort(byRef), pads: [...pads].sort(byRef) });
    }
  }
  if (mismatches.length) throw new PadMismatchError(mismatches);

  const boundsOf = new Map(netlist.parts.map((p) => [p.ref, footprintBounds(mods.get(p.footprint)!.text, { ref: p.ref, value: p.value })]));

  // biggest first: the module anchors the pack; ties by refdes for stability
  const order = [...netlist.parts].sort((a, b) => {
    const area = (p: NetlistPart): number => {
      const bb = boundsOf.get(p.ref)!;
      return (bb.maxX - bb.minX) * (bb.maxY - bb.minY);
    };
    return area(b) - area(a) || byRef(a.ref, b.ref);
  });
  const boxes = order.map((p) => {
    const bb = boundsOf.get(p.ref)!;
    return { w: bb.maxX - bb.minX, h: bb.maxY - bb.minY };
  });

  const open = boardText.indexOf('(kicad_pcb');
  if (open < 0) throw new Error(`${opts.board} is not a KiCad board`);
  const rect = outlineRect(boardText, open);
  // an outline populate cannot resize still bounds the pack: parts go inside
  // its box, and a pack that does not fit stops instead of landing off-board
  const fixed = rect ? null : outlineBox(boardText, open);
  const origin = rect
    ? { x: rect.x1 + MARGIN, y: rect.y1 + MARGIN }
    : fixed
      ? { x: fixed.minX + MARGIN, y: fixed.minY + MARGIN }
      : { x: 100 + MARGIN, y: 100 + MARGIN };
  const totalArea = boxes.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0);
  const widest = Math.max(...boxes.map((b) => b.w));
  // rows as wide as the outline, or roughly square when the parts need more
  // room than it has, so a large design grows the board both ways
  const width = fixed
    ? Math.max(widest, fixed.maxX - fixed.minX - 2 * MARGIN)
    : Math.max(widest, rect ? rect.x2 - rect.x1 - 2 * MARGIN : 0, Math.sqrt(totalArea));
  const origins = shelfPack(boxes, width, GAP);

  const blocks = order.map((p, i) => {
    const bb = boundsOf.get(p.ref)!;
    return instantiateFootprint(mods.get(p.footprint)!.text, {
      fpId: p.footprint,
      ref: p.ref,
      value: p.value,
      uuid: uuidv5(`board-footprint/${p.path || p.ref}`),
      // the footprint origin sits at -minX/-minY inside its box
      at: { x: origin.x + origins[i]!.x - bb.minX, y: origin.y + origins[i]!.y - bb.minY },
      path: p.path,
      sheetname: p.sheetname,
      sheetfile: p.sheetfile,
      padNet: (pad) => netOf.get(`${p.ref}\0${pad}`),
    });
  });
  const usedW = Math.max(...order.map((_, i) => origins[i]!.x + boxes[i]!.w));
  const usedH = Math.max(...order.map((_, i) => origins[i]!.y + boxes[i]!.h));
  if (fixed && (usedW + 2 * MARGIN > fixed.maxX - fixed.minX || usedH + 2 * MARGIN > fixed.maxY - fixed.minY)) {
    throw new Error(
      `the parts need about ${Math.ceil(usedW + 2 * MARGIN)} x ${Math.ceil(usedH + 2 * MARGIN)} mm, more than the ` +
        `${num(fixed.maxX - fixed.minX)} x ${num(fixed.maxY - fixed.minY)} mm outline of ${opts.board}, and populate ` +
        'grows only a single-rectangle outline; enlarge the Edge.Cuts outline, then re-run',
    );
  }
  if (fixed) {
    // the box is not the board: an L-shape, a circle, or a cutout leaves parts
    // of it off-board, so every packed part must lie inside the real outline
    const segs = outlineSegments(boardText, open);
    const outside = order
      .filter((_, i) => {
        const b: Bounds = {
          minX: origin.x + origins[i]!.x,
          minY: origin.y + origins[i]!.y,
          maxX: origin.x + origins[i]!.x + boxes[i]!.w,
          maxY: origin.y + origins[i]!.y + boxes[i]!.h,
        };
        const corners: [number, number][] = [
          [b.minX, b.minY],
          [b.maxX, b.minY],
          [b.minX, b.maxY],
          [b.maxX, b.maxY],
        ];
        return corners.some(([x, y]) => !insideOutline(segs, x, y)) || outlineCrossesBox(segs, b);
      })
      .map((p) => p.ref);
    if (outside.length) {
      throw new Error(
        `packed on a grid, ${outside.join(', ')} would land outside the Edge.Cuts outline of ${opts.board}, which is not a ` +
          'single rectangle, and populate grows only a single-rectangle outline; make room inside the outline, or use a ' +
          'rectangular one and shape it after placement, then re-run',
      );
    }
  }

  // splice: net table after `(net 0 "")` (or before the first footprint-able
  // item), outline grown when the pack overflows it, footprints before the
  // board's closing paren
  let text = boardText;
  const edits: { at: number; del: number; ins: string }[] = [];
  let grown = false;
  let outline = { width: rect ? rect.x2 - rect.x1 : 0, height: rect ? rect.y2 - rect.y1 : 0 };
  if (rect) {
    const needW = usedW + 2 * MARGIN;
    const needH = usedH + 2 * MARGIN;
    if (needW > rect.x2 - rect.x1 || needH > rect.y2 - rect.y1) {
      const w = Math.ceil(Math.max(needW, rect.x2 - rect.x1));
      const h = Math.ceil(Math.max(needH, rect.y2 - rect.y1));
      const old = text.slice(rect.start, rect.end);
      const next = old
        .replace(/\(start\s+[-\d.]+\s+[-\d.]+\)/, `(start ${num(rect.x1)} ${num(rect.y1)})`)
        .replace(/\(end\s+[-\d.]+\s+[-\d.]+\)/, `(end ${num(rect.x1 + w)} ${num(rect.y1 + h)})`);
      edits.push({ at: rect.start, del: rect.end - rect.start, ins: next });
      outline = { width: w, height: h };
      grown = true;
    }
  }
  const netDecl = netNames.map((n) => `\t(net ${code.get(n)} ${q(n)})`).join('\n');
  const net0 = /\(net\s+0\s+""\)/.exec(text);
  if (net0) edits.push({ at: net0.index + net0[0].length, del: 0, ins: `\n${netDecl}` });
  else {
    const first = childSpans(text, open).find((s) => /^(gr_|footprint|segment|via|zone)/.test(s.tag));
    const at = first ? first.start : listEnd(text, open) - 1;
    edits.push({ at, del: 0, ins: `(net 0 "")\n${netDecl}\n\t` });
  }
  const close = listEnd(text, open) - 1;
  edits.push({ at: close, del: 0, ins: `${blocks.join('\n')}\n` });
  for (const e of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, e.at) + e.ins + text.slice(e.at + e.del);

  // KiCad must load it before it replaces the board (AC-15.37)
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-populate-'));
  try {
    const probe = path.join(dir, path.basename(boardPath));
    await writeFile(probe, text, 'utf8');
    const err = await kicadLoadError(probe);
    if (err) throw new Error(`the populated board does not load in KiCad, so ${opts.board} was left unchanged: ${err}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await writeFile(boardPath, text, 'utf8');
  return {
    placed: netlist.parts.map((p) => ({ ref: p.ref, footprint: p.footprint })),
    nets: netNames.length,
    outline: { ...outline, grown },
    unchanged: false,
  };
}

// ---- moving a placed footprint ----------------------------------------------

const normAngle = (a: number): number => {
  const r = Math.round((((a % 360) + 360) % 360) * 1e4) / 1e4;
  return r === 360 ? 0 : r;
};
const atText = (x: number, y: number, a: number): string => `(at ${num(x)} ${num(y)}${a ? ` ${num(a)}` : ''})`;

/**
 * Move (and optionally rotate) one placed footprint, found by refdes (#314).
 * A KiCad board stores every pad's and text's angle as ABSOLUTE, so turning a
 * footprint by editing only its own `(at X Y ROT)` leaves the pads facing the
 * old way: the part no longer matches its library and fine-pitch pads short
 * into each other. Its zones are stored in board coordinates, so they move
 * and turn with it too. All by anchored splices only.
 */
export function moveFootprint(boardText: string, ref: string, x: number, y: number, rotation?: number): string {
  const open = boardText.indexOf('(kicad_pcb');
  if (open < 0) throw new Error('not a KiCad board');
  const owns = (s: Span): boolean => {
    const t = boardText.slice(s.start, s.end);
    return t.includes(`(property "Reference" ${q(ref)}`) || t.includes(`(fp_text reference ${q(ref)}`);
  };
  const fps = childSpans(boardText, open).filter((s) => s.tag === 'footprint' && owns(s));
  if (fps.length !== 1) throw new Error(fps.length ? `more than one footprint has refdes ${ref}` : `no footprint with refdes ${ref} on the board`);
  const fp = fps[0]!;
  const kids = childSpans(boardText, fp.start);
  const at = kids.find((k) => k.tag === 'at');
  if (!at) throw new Error(`${ref} has no (at …) placement`);
  const nums = boardText.slice(at.start, at.end).match(/-?[\d.]+/g)?.map(Number) ?? [];
  const from = normAngle(nums[2] ?? 0);
  const to = normAngle(rotation ?? from);
  const delta = to - from;
  const edits: { start: number; end: number; text: string }[] = [{ start: at.start, end: at.end, text: atText(x, y, to) }];
  for (const k of kids) {
    if (k.tag !== 'zone') continue;
    const from = { x: nums[0] ?? 0, y: nums[1] ?? 0 };
    edits.push({ start: k.start, end: k.end, text: moveZonePoints(boardText.slice(k.start, k.end), from, { x, y }, delta) });
  }
  if (delta) {
    for (const k of kids) {
      if (k.tag !== 'pad' && k.tag !== 'property' && k.tag !== 'fp_text') continue;
      const own = childSpans(boardText, k.start).find((c) => c.tag === 'at');
      if (!own) continue;
      const v = boardText.slice(own.start, own.end).match(/-?[\d.]+/g)?.map(Number) ?? [];
      const rest = / unlocked\)$/.test(boardText.slice(own.start, own.end)) ? ' unlocked' : '';
      edits.push({ start: own.start, end: own.end, text: atText(v[0] ?? 0, v[1] ?? 0, normAngle((v[2] ?? 0) + delta)).replace(/\)$/, `${rest})`) });
    }
  }
  let text = boardText;
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return text;
}

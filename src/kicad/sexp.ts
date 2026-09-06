import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Minimal READ-ONLY s-expression tooling for .kicad_sch files. This module
 * never serializes: edits to KiCad files happen as anchored text replaces on
 * the original source (SPEC §1.3 / design D4).
 */

export type SexpNode = string | SexpNode[];

export function parseSexp(text: string): SexpNode[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '(' || c === ')') {
      tokens.push(c);
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          // KiCad writes multi-line text as `\n` (and tabs as `\t`) inside the
          // quoted atom; mapping the escape to the literal letter would give
          // the legibility width model a one-line `line1nline2` string.
          const e = text[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e!;
          j += 2;
        } else {
          s += text[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(s));
      i = j + 1;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let j = i;
      while (j < text.length && !/[\s()"]/.test(text[j]!)) j++;
      tokens.push(text.slice(i, j));
      i = j;
    }
  }
  let pos = 0;
  function parseNode(): SexpNode {
    const tok = tokens[pos++]!;
    if (tok === '(') {
      const list: SexpNode[] = [];
      while (pos < tokens.length && tokens[pos] !== ')') list.push(parseNode());
      pos++; // consume ')'
      return list;
    }
    return tok.startsWith('"') ? (JSON.parse(tok) as string) : tok;
  }
  const roots: SexpNode[] = [];
  while (pos < tokens.length) roots.push(parseNode());
  return roots;
}

export const isList = (n: SexpNode): n is SexpNode[] => Array.isArray(n);
const tag = (n: SexpNode): string | null => (isList(n) && typeof n[0] === 'string' ? n[0] : null);

export function children(node: SexpNode, name: string): SexpNode[][] {
  if (!isList(node)) return [];
  return node.filter((c): c is SexpNode[] => tag(c) === name);
}

export function child(node: SexpNode, name: string): SexpNode[] | undefined {
  return children(node, name)[0];
}

function atomAt(node: SexpNode[] | undefined, idx: number): string | undefined {
  const v = node?.[idx];
  return typeof v === 'string' ? v : undefined;
}

function property(sym: SexpNode[], key: string): string | undefined {
  for (const p of children(sym, 'property')) {
    if (atomAt(p, 1) === key) return atomAt(p, 2);
  }
  return undefined;
}

export interface SchematicSymbol {
  ref: string;
  value: string;
  footprint: string;
  libId: string;
  sheet: string;
  at: { x: number; y: number; rot: number };
  uuid: string;
  /** `(unit N)` of the placed instance; 1 for single-unit symbols. */
  unit: number;
}

export interface PinDef {
  number: string;
  name: string;
  x: number;
  y: number;
  /** Unit the pin belongs to (from the `_<unit>_<style>` child it sits in);
   * 0 for a pin in the common unit, drawn on every placed unit. */
  unit: number;
}

interface ParsedSheet {
  filePath: string;
  sheetName: string;
  root: SexpNode[];
}

async function loadSheets(rootSch: string): Promise<ParsedSheet[]> {
  const seen = new Set<string>();
  const out: ParsedSheet[] = [];
  async function load(file: string, sheetName: string): Promise<void> {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    const text = await readFile(abs, 'utf8');
    const root = parseSexp(text)[0];
    if (root === undefined || !isList(root)) {
      throw new Error(`not a KiCad s-expression file: ${file}`);
    }
    out.push({ filePath: abs, sheetName, root });
    for (const sheet of children(root, 'sheet')) {
      const sub = property(sheet, 'Sheetfile') ?? property(sheet, 'Sheet file');
      const name = property(sheet, 'Sheetname') ?? property(sheet, 'Sheet name') ?? 'sheet';
      if (sub) await load(path.resolve(path.dirname(abs), sub), name);
    }
  }
  await load(rootSch, '/');
  return out;
}

/** Pin definitions per lib symbol name, in symbol coordinates. Each pin
 * carries the unit of the `_<unit>_<style>` child it was defined in (0 for
 * the common unit); de Morgan alternates (style ≥ 2) are skipped so a pin is
 * recorded once. */
function libPinDefs(root: SexpNode[]): Map<string, PinDef[]> {
  const map = new Map<string, PinDef[]>();
  const libs = child(root, 'lib_symbols');
  if (!libs) return map;
  for (const sym of children(libs, 'symbol')) {
    const name = atomAt(sym, 1);
    if (!name) continue;
    const pins: PinDef[] = [];
    const walk = (n: SexpNode, unit: number): void => {
      if (!isList(n)) return;
      if (tag(n) === 'symbol') {
        const m = /_(\d+)_(\d+)$/.exec(atomAt(n, 1) ?? '');
        if (m) {
          if (Number(m[2]) >= 2) return; // de Morgan alternate body style
          unit = Number(m[1]);
        }
      }
      if (tag(n) === 'pin') {
        const at = child(n, 'at');
        const num = atomAt(child(n, 'number'), 1);
        const pinName = atomAt(child(n, 'name'), 1);
        if (at && num !== undefined) {
          pins.push({
            number: num,
            name: pinName ?? '~',
            x: parseFloat(atomAt(at, 1) ?? '0'),
            y: parseFloat(atomAt(at, 2) ?? '0'),
            unit,
          });
        }
      }
      for (const c of n) walk(c, unit);
    };
    walk(sym, 0);
    map.set(name, pins);
  }
  return map;
}

/** The pins a PLACED instance actually shows: its own unit's plus the common
 * unit's. A single-unit symbol keeps every pin (they are all unit ≤ 1). */
export function pinsOfUnit(defs: PinDef[], unit: number): PinDef[] {
  const multi = defs.some((p) => p.unit >= 2);
  if (!multi) return defs;
  return defs.filter((p) => p.unit === 0 || p.unit === unit);
}

/** Symbol-space → schematic-space transform (schematic Y grows downward). */
export function pinAbsolute(
  symAt: { x: number; y: number; rot: number },
  mirror: 'x' | 'y' | null,
  pin: { x: number; y: number },
): { x: number; y: number } {
  let px = pin.x;
  let py = pin.y;
  if (mirror === 'y') px = -px;
  if (mirror === 'x') py = -py;
  const theta = (symAt.rot * Math.PI) / 180;
  const rx = px * Math.cos(theta) - py * Math.sin(theta);
  const ry = px * Math.sin(theta) + py * Math.cos(theta);
  return { x: round(symAt.x + rx), y: round(symAt.y - ry) };
}

const round = (n: number): number => Math.round(n * 10000) / 10000;
const key = (x: number, y: number): string => `${round(x)},${round(y)}`;

class UnionFind {
  private parent = new Map<string, string>();
  find(k: string): string {
    let p = this.parent.get(k);
    if (p === undefined) {
      this.parent.set(k, k);
      return k;
    }
    if (p !== k) {
      p = this.find(p);
      this.parent.set(k, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

function symbolsOf(sheet: ParsedSheet): { node: SexpNode[]; sym: SchematicSymbol; mirror: 'x' | 'y' | null }[] {
  const out: { node: SexpNode[]; sym: SchematicSymbol; mirror: 'x' | 'y' | null }[] = [];
  for (const s of children(sheet.root, 'symbol')) {
    const libId = atomAt(child(s, 'lib_id'), 1);
    if (!libId) continue; // lib_symbols entries have no lib_id child
    const at = child(s, 'at');
    const mirrorAtom = atomAt(child(s, 'mirror'), 1);
    out.push({
      node: s,
      mirror: mirrorAtom === 'x' || mirrorAtom === 'y' ? mirrorAtom : null,
      sym: {
        ref: property(s, 'Reference') ?? '?',
        value: property(s, 'Value') ?? '',
        footprint: property(s, 'Footprint') ?? '',
        libId,
        sheet: sheet.sheetName,
        at: {
          x: parseFloat(atomAt(at, 1) ?? '0'),
          y: parseFloat(atomAt(at, 2) ?? '0'),
          rot: parseFloat(atomAt(at, 3) ?? '0'),
        },
        uuid: atomAt(child(s, 'uuid'), 1) ?? '',
        unit: parseInt(atomAt(child(s, 'unit'), 1) ?? '1', 10) || 1,
      },
    });
  }
  return out;
}

function collectPowerSymbols(sheets: ParsedSheet[]): Set<string> {
  const set = new Set<string>();
  for (const sheet of sheets) {
    const libs = child(sheet.root, 'lib_symbols');
    if (!libs) continue;
    for (const sym of children(libs, 'symbol')) {
      const name = atomAt(sym, 1);
      const p = child(sym, 'power');
      if (name && p !== undefined && atomAt(p, 1) !== 'no') {
        set.add(name);
      }
    }
  }
  return set;
}

const isPowerSymbol = (libId: string, powerSyms: Set<string>): boolean =>
  libId.startsWith('power:') || powerSyms.has(libId);

/** One row per real component (power symbols excluded), across all sheets. */
export async function listSymbols(rootSch: string): Promise<SchematicSymbol[]> {
  const sheets = await loadSheets(rootSch);
  const powerSyms = collectPowerSymbols(sheets);
  const out: SchematicSymbol[] = [];
  for (const sheet of sheets) {
    for (const { sym } of symbolsOf(sheet)) {
      if (!isPowerSymbol(sym.libId, powerSyms)) out.push(sym);
    }
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

/** All net names visible via labels and power symbols, across all sheets. */
export async function listNets(rootSch: string): Promise<string[]> {
  const sheets = await loadSheets(rootSch);
  const powerSyms = collectPowerSymbols(sheets);
  const names = new Set<string>();
  for (const sheet of sheets) {
    for (const kind of ['label', 'global_label', 'hierarchical_label']) {
      for (const l of children(sheet.root, kind)) {
        const name = atomAt(l, 1);
        if (name) names.add(name);
      }
    }
    for (const { sym } of symbolsOf(sheet)) {
      if (isPowerSymbol(sym.libId, powerSyms)) names.add(sym.value);
    }
  }
  return [...names].sort();
}

export interface PinNet {
  ref: string;
  pinNumber: string;
  pinName: string;
  net: string | null;
}

// ---------- Read-only geometry accessors for the legibility checker ----------

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface WireSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TextItem {
  text: string;
  x: number;
  y: number;
  rot: number;
  /** Font height in mm (KiCad `(size h w)`); 1.27 when unstated. */
  height: number;
  hidden: boolean;
  /** `(justify …)` components, or null when unspecified: KiCad anchors a
   * free text at its centre unless the effects say otherwise, and the
   * engine's group captions say `left top`. */
  justifyH: 'left' | 'right' | null;
  justifyV: 'top' | 'bottom' | null;
}

export interface LabelItem {
  name: string;
  kind: 'label' | 'global_label' | 'hierarchical_label';
  x: number;
  y: number;
  rot: number;
  height: number;
  /** Horizontal component of `(justify …)`, or null when unspecified. KiCad
   * normalizes angles 180/270 to 0/90 at draw time and the stored justify
   * describes that DRAWN frame, so a leftward label appears as angle 180 (no
   * justify), angle 180 + justify right, or angle 0 + justify right — all the
   * same box. */
  justify: 'left' | 'right' | null;
}

export interface RectItem {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeType: string;
}

export interface PlacedSymbolGeom {
  ref: string;
  libId: string;
  value: string;
  at: { x: number; y: number; rot: number };
  mirror: 'x' | 'y' | null;
  isPower: boolean;
  /** `(unit N)` of the placed instance; 1 for single-unit symbols. */
  unit: number;
  /** Reference and Value property text (absolute schematic coordinates). */
  props: TextItem[];
}

export interface SheetGeometry {
  filePath: string;
  sheetName: string;
  /** `(paper …)`: standard name, or explicit size when the file states one. */
  paper: { name: string | null; width: number | null; height: number | null; portrait: boolean };
  titleBlock: { title: string; date: string; rev: string } | null;
  symbols: PlacedSymbolGeom[];
  wires: WireSeg[];
  labels: LabelItem[];
  /** Free `(text …)` items (group captions live here). */
  texts: TextItem[];
  /** Sheet-level `(rectangle …)` graphics (group boxes live here). */
  rectangles: RectItem[];
  /** Union bounds of each lib symbol's body graphics, symbol space; null when the entry draws nothing. */
  libBounds: Map<string, Bounds | null>;
  libPins: Map<string, PinDef[]>;
}

const num = (n: SexpNode[] | undefined, idx: number, fallback = 0): number => {
  const v = atomAt(n, idx);
  return v === undefined ? fallback : parseFloat(v);
};

function effectsOf(node: SexpNode[]): { height: number; hidden: boolean } {
  const effects = child(node, 'effects');
  const font = effects ? child(effects, 'font') : undefined;
  const size = font ? child(font, 'size') : undefined;
  // hidden: legacy bare `hide` atom, or v9 `(hide yes)`
  const hideNode = effects ? child(effects, 'hide') : undefined;
  const hidden =
    (effects?.some((c) => c === 'hide') ?? false) || (hideNode !== undefined && atomAt(hideNode, 1) !== 'no');
  return { height: size ? num(size, 1, 1.27) : 1.27, hidden };
}

function libBodyBounds(root: SexpNode[]): Map<string, Bounds | null> {
  const map = new Map<string, Bounds | null>();
  const libs = child(root, 'lib_symbols');
  if (!libs) return map;
  for (const sym of children(libs, 'symbol')) {
    const name = atomAt(sym, 1);
    if (!name) continue;
    /** Union across the whole symbol under `name`, per-unit union (common
     * graphics included) under `name#<unit>` — a placed unit of a multi-unit
     * symbol draws only its own unit's graphics, so measuring it with the
     * package union would size every instance like the whole gate pack. */
    const perUnit = new Map<number, Bounds | null>();
    let b: Bounds | null = null;
    const grow = (prev: Bounds | null, x: number, y: number): Bounds => {
      if (!prev) return { minX: x, minY: y, maxX: x, maxY: y };
      prev.minX = Math.min(prev.minX, x);
      prev.minY = Math.min(prev.minY, y);
      prev.maxX = Math.max(prev.maxX, x);
      prev.maxY = Math.max(prev.maxY, y);
      return prev;
    };
    const walk = (n: SexpNode, unit: number | null): void => {
      if (!isList(n)) return;
      const t = tag(n);
      if (t === 'symbol') {
        const m = /_(\d+)_(\d+)$/.exec(atomAt(n, 1) ?? '');
        if (m) {
          if (Number(m[2]) >= 2) return; // de Morgan alternate body style
          unit = Number(m[1]);
        }
      }
      const extend = (x: number, y: number): void => {
        b = grow(b, x, y);
        if (unit !== null) perUnit.set(unit, grow(perUnit.get(unit) ?? null, x, y));
      };
      if (t === 'rectangle') {
        const s = child(n, 'start');
        const e = child(n, 'end');
        extend(num(s, 1), num(s, 2));
        extend(num(e, 1), num(e, 2));
      } else if (t === 'circle') {
        const c = child(n, 'center');
        const r = num(child(n, 'radius'), 1);
        extend(num(c, 1) - r, num(c, 2) - r);
        extend(num(c, 1) + r, num(c, 2) + r);
      } else if (t === 'arc') {
        for (const part of ['start', 'mid', 'end']) {
          const p = child(n, part);
          if (p) extend(num(p, 1), num(p, 2));
        }
      } else if (t === 'polyline') {
        for (const xy of children(child(n, 'pts') ?? [], 'xy')) extend(num(xy, 1), num(xy, 2));
      }
      // pin/text graphics are deliberately excluded from the body box (design C2)
      if (t !== 'pin' && t !== 'text') for (const c of n) walk(c, unit);
    };
    walk(sym, null);
    map.set(name, b);
    const common = perUnit.get(0) ?? null;
    for (const [unit, ub] of perUnit) {
      if (unit === 0) continue;
      const merged =
        ub && common
          ? {
              minX: Math.min(ub.minX, common.minX),
              minY: Math.min(ub.minY, common.minY),
              maxX: Math.max(ub.maxX, common.maxX),
              maxY: Math.max(ub.maxY, common.maxY),
            }
          : (ub ?? (common ? { ...common } : null));
      map.set(`${name}#${unit}`, merged);
    }
  }
  return map;
}

function textItemsOf(sym: SexpNode[]): TextItem[] {
  const out: TextItem[] = [];
  for (const p of children(sym, 'property')) {
    const key = atomAt(p, 1);
    if (key !== 'Reference' && key !== 'Value') continue;
    const at = child(p, 'at');
    const fx = effectsOf(p);
    out.push({
      text: atomAt(p, 2) ?? '',
      x: num(at, 1),
      y: num(at, 2),
      rot: num(at, 3),
      height: fx.height,
      hidden: fx.hidden,
      // property text keeps the centred measurement: its justification is
      // relative to the symbol's own rotation and mirror, which the checker
      // does not model, and the engine emits it centred
      justifyH: null,
      justifyV: null,
    });
  }
  return out;
}

/**
 * Everything the legibility checker needs to see per sheet, extracted read-only.
 * Never serializes and never mutates the file.
 */
export async function readSheetGeometry(rootSch: string): Promise<SheetGeometry[]> {
  const sheets = await loadSheets(rootSch);
  const powerSyms = collectPowerSymbols(sheets);
  return sheets.map((sheet) => {
    const paperNode = child(sheet.root, 'paper');
    const paperName = atomAt(paperNode, 1) ?? null;
    const portrait = paperNode?.includes('portrait') ?? false;
    const explicitW = num(paperNode, 2, NaN);
    const explicitH = num(paperNode, 3, NaN);
    const tb = child(sheet.root, 'title_block');
    const tbField = (name: string): string => (tb ? (atomAt(child(tb, name), 1) ?? '') : '');
    const wires: WireSeg[] = [];
    for (const w of children(sheet.root, 'wire')) {
      const pts = children(child(w, 'pts') ?? [], 'xy');
      for (let i = 1; i < pts.length; i++) {
        wires.push({ x1: num(pts[i - 1], 1), y1: num(pts[i - 1], 2), x2: num(pts[i], 1), y2: num(pts[i], 2) });
      }
    }
    const labels: LabelItem[] = [];
    for (const kind of ['label', 'global_label', 'hierarchical_label'] as const) {
      for (const l of children(sheet.root, kind)) {
        const at = child(l, 'at');
        const effects = child(l, 'effects');
        const justify = effects ? child(effects, 'justify') : undefined;
        labels.push({
          name: atomAt(l, 1) ?? '',
          kind,
          x: num(at, 1),
          y: num(at, 2),
          rot: num(at, 3),
          height: effectsOf(l).height,
          justify: justify?.some((c) => c === 'right') ? 'right' : justify?.some((c) => c === 'left') ? 'left' : null,
        });
      }
    }
    const texts: TextItem[] = children(sheet.root, 'text').map((t) => {
      const at = child(t, 'at');
      const fx = effectsOf(t);
      const effects = child(t, 'effects');
      const justify = effects ? child(effects, 'justify') : undefined;
      return {
        text: atomAt(t, 1) ?? '',
        x: num(at, 1),
        y: num(at, 2),
        rot: num(at, 3),
        height: fx.height,
        hidden: fx.hidden,
        justifyH: justify?.some((c) => c === 'right') ? 'right' : justify?.some((c) => c === 'left') ? 'left' : null,
        justifyV: justify?.some((c) => c === 'bottom') ? 'bottom' : justify?.some((c) => c === 'top') ? 'top' : null,
      };
    });
    const rectangles: RectItem[] = children(sheet.root, 'rectangle').map((r) => {
      const s = child(r, 'start');
      const e = child(r, 'end');
      const stroke = child(r, 'stroke');
      return {
        x1: num(s, 1),
        y1: num(s, 2),
        x2: num(e, 1),
        y2: num(e, 2),
        strokeType: atomAt(child(stroke ?? [], 'type'), 1) ?? 'default',
      };
    });
    return {
      filePath: sheet.filePath,
      sheetName: sheet.sheetName,
      paper: {
        name: paperName,
        width: Number.isNaN(explicitW) ? null : explicitW,
        height: Number.isNaN(explicitH) ? null : explicitH,
        portrait,
      },
      titleBlock: tb ? { title: tbField('title'), date: tbField('date'), rev: tbField('rev') } : null,
      symbols: symbolsOf(sheet).map(({ sym, mirror, node }) => ({
        ref: sym.ref,
        libId: sym.libId,
        value: sym.value,
        at: sym.at,
        mirror,
        isPower: isPowerSymbol(sym.libId, powerSyms),
        unit: sym.unit,
        props: textItemsOf(node),
      })),
      wires,
      labels,
      texts,
      rectangles,
      libBounds: libBodyBounds(sheet.root),
      libPins: libPinDefs(sheet.root),
    };
  });
}

/**
 * Geometric connectivity per sheet: pins, labels, and wire endpoints that share
 * coordinates (or are joined by wires) form a group; a group's net name comes
 * from its labels or power symbols. Good enough for docs scaffolding and drift
 * checks; not a full netlister.
 */
export async function pinNets(rootSch: string): Promise<PinNet[]> {
  const sheets = await loadSheets(rootSch);
  const powerSyms = collectPowerSymbols(sheets);
  const out: PinNet[] = [];
  for (const sheet of sheets) {
    const pinDefs = libPinDefs(sheet.root);
    const uf = new UnionFind();
    const netNameAt = new Map<string, string>();

    for (const w of children(sheet.root, 'wire')) {
      const pts = children(child(w, 'pts') ?? [], 'xy').map((xy) => ({
        x: parseFloat(atomAt(xy, 1) ?? '0'),
        y: parseFloat(atomAt(xy, 2) ?? '0'),
      }));
      for (let i = 1; i < pts.length; i++) {
        uf.union(key(pts[0]!.x, pts[0]!.y), key(pts[i]!.x, pts[i]!.y));
      }
    }
    for (const kind of ['label', 'global_label', 'hierarchical_label']) {
      for (const l of children(sheet.root, kind)) {
        const name = atomAt(l, 1);
        const at = child(l, 'at');
        if (!name || !at) continue;
        const k = key(parseFloat(atomAt(at, 1) ?? '0'), parseFloat(atomAt(at, 2) ?? '0'));
        uf.find(k);
        netNameAt.set(k, name);
      }
    }

    const symPins: { sym: SchematicSymbol; pin: PinDef; k: string }[] = [];
    for (const { sym, mirror } of symbolsOf(sheet)) {
      // a placed unit of a multi-unit symbol shows only its own unit's pins;
      // resolving the whole package at each instance would invent phantom
      // connection points at every other unit's coordinates
      const defs = pinsOfUnit(pinDefs.get(sym.libId) ?? [], sym.unit);
      for (const pin of defs) {
        const abs = pinAbsolute(sym.at, mirror, pin);
        const k = key(abs.x, abs.y);
        uf.find(k);
        if (isPowerSymbol(sym.libId, powerSyms)) {
          netNameAt.set(k, sym.value);
        } else {
          symPins.push({ sym, pin, k });
        }
      }
    }

    const groupNet = new Map<string, string>();
    for (const [k, name] of netNameAt) groupNet.set(uf.find(k), name);
    for (const { sym, pin, k } of symPins) {
      out.push({
        ref: sym.ref,
        pinNumber: pin.number,
        pinName: pin.name,
        net: groupNet.get(uf.find(k)) ?? null,
      });
    }
  }
  return out;
}

export interface BoardFootprint {
  ref: string;
  value: string;
  footprintId: string;
  at: { x: number; y: number; rot: number };
  layer: string;
}

/** Parse and list all footprints present on a KiCad PCB layout board file (.kicad_pcb). */
export async function listBoardFootprints(boardPath: string): Promise<BoardFootprint[]> {
  const abs = path.resolve(boardPath);
  const text = await readFile(abs, 'utf8');
  const roots = parseSexp(text);
  const boardNode = roots.find((r) => tag(r) === 'kicad_pcb');
  if (!boardNode || !isList(boardNode)) {
    throw new Error(`not a KiCad PCB file: ${boardPath}`);
  }

  const out: BoardFootprint[] = [];
  for (const fpNode of children(boardNode, 'footprint')) {
    const footprintId = atomAt(fpNode, 1) ?? '';

    let ref = '';
    let value = '';

    for (const prop of children(fpNode, 'property')) {
      if (atomAt(prop, 1) === 'Reference') ref = atomAt(prop, 2) ?? '';
      if (atomAt(prop, 1) === 'Value') value = atomAt(prop, 2) ?? '';
    }

    if (!ref || !value) {
      for (const txt of children(fpNode, 'fp_text')) {
        if (!ref && atomAt(txt, 1) === 'reference') ref = atomAt(txt, 2) ?? '';
        if (!value && atomAt(txt, 1) === 'value') value = atomAt(txt, 2) ?? '';
      }
    }

    const atNode = child(fpNode, 'at');
    const x = parseFloat(atomAt(atNode, 1) ?? '0');
    const y = parseFloat(atomAt(atNode, 2) ?? '0');
    const rot = parseFloat(atomAt(atNode, 3) ?? '0');

    const layerNode = child(fpNode, 'layer');
    const layer = atomAt(layerNode, 1) ?? 'F.Cu';

    out.push({
      ref: ref || '?',
      value,
      footprintId,
      at: { x, y, rot },
      layer,
    });
  }

  return out.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

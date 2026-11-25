/**
 * KiCad board import (RFC 11 §6, ADR 0004, implementation spec §4.2): a
 * read-only reader from `.kicad_pcb` (+ `.kicad_pro`, `.kicad_dru`) text into
 * the canonical IR. Nothing here serializes; the exporter works on the source
 * text with the same block offsets.
 *
 * Conventions verified against pcbnew on a KiCad 10 board (StickHub demo):
 *  - pad absolute position = footprint origin + R(footprint rotation) · local,
 *    with x' = x·cos + y·sin and y' = −x·sin + y·cos (Y-down frame), for front
 *    AND back footprints; back-side local coordinates are not mirrored
 *  - a pad's `(at x y rot)` rotation is its absolute orientation; the pad's own
 *    rotation relative to the footprint is `rot − footprint rot`
 */
import { parseSexp, children, child, isList, type SexpNode } from '../../../kicad/sexp.js';
import { copperStack, defaultProfileIdFor } from '../layers.js';
import { uuidv5 } from '../../../kicad/emit.js';
import { mmToNm, degToMdeg, normMdeg, type Nm, type Mdeg } from '../units.js';
import {
  type Point, type Polygon, rect, circle, stadium, roundRect, capsule, placeLocal, rotatePoint, union, area,
  chainLoops, bboxOf, rectFromBounds,
} from '../geometry.js';
import type {
  PcbDesign, LayerDefinition, LayerKind, ComponentInstance, PadDefinition, PadShape, PadType, NetDefinition,
  TrackSegment, TrackArc, Via, CopperZone, Keepout, DesignRules, PreservedBlock, FootprintDefinition,
} from '../types.js';
import { IR_SCHEMA_VERSION } from '../types.js';
import { hashDesign } from '../canonical.js';
import { topLevelBlocks, childBlocks, stripChildren, type Block } from './blocks.js';

/** Oldest and newest board file versions the reader accepts (ADR 0004). */
export const MIN_BOARD_VERSION = 20240108; // KiCad 8.0
export const MAX_BOARD_VERSION = 20261231; // KiCad 10.0.4 writes 20260206 (verified with kicad-cli --save-board)

export class UnsupportedBoardVersion extends Error {
  constructor(public readonly version: number) {
    super(`board file version ${version} is newer than the pinned KiCad 10 format (max ${MAX_BOARD_VERSION}); upgrade copperhead or save with KiCad 10`);
    this.name = 'UnsupportedBoardVersion';
  }
}

export interface ImportInput {
  boardText: string;
  /** Repo-relative path, recorded in provenance. */
  boardPath: string;
  projectText?: string;
  projectPath?: string;
  druText?: string;
  druPath?: string;
  kicadVersion?: string;
  fabricationProfile?: string;
  /** Fixed timestamp for tests. */
  now?: string;
}

/** User-authored ECAD constraints found in the project, for the intent compiler (RFC 11 §7.5). */
export interface EcadRules {
  netClasses: { name: string; clearanceNm?: Nm; trackWidthNm?: Nm; viaDiameterNm?: Nm; viaDrillNm?: Nm; diffPairGapNm?: Nm; nets: string[]; patterns: string[] }[];
  druRules: { name: string; condition: string | null; constraint: string; text: string }[];
  lockedComponentIds: string[];
}

export interface ImportResult {
  design: PcbDesign;
  ecad: EcadRules;
  warnings: string[];
}

const atom = (n: SexpNode[] | undefined, i: number): string | undefined => (typeof n?.[i] === 'string' ? (n![i] as string) : undefined);
const num = (n: SexpNode[] | undefined, i: number): number | undefined => {
  const v = atom(n, i);
  if (v === undefined) return undefined;
  const f = Number(v);
  return Number.isFinite(f) ? f : undefined;
};
const nm = (n: SexpNode[] | undefined, i: number): Nm | undefined => {
  const v = num(n, i);
  return v === undefined ? undefined : mmToNm(v);
};
const pt = (n: SexpNode[] | undefined): Point | undefined => {
  const x = nm(n, 1);
  const y = nm(n, 2);
  return x === undefined || y === undefined ? undefined : { x, y };
};
const first = (text: string): SexpNode[] | undefined => {
  const r = parseSexp(text)[0];
  return r && isList(r) ? r : undefined;
};

/**
 * A `(net …)` reference in either dialect: `(net 3 "GND")` / `(net 3)` (code) or
 * `(net "GND")` (name, KiCad 10.0.4's 20260206 format, which has no net table).
 */
function netRef(node: SexpNode[] | undefined): { code?: number; name?: string } | null {
  if (!node) return null;
  const a1 = atom(node, 1);
  if (a1 === undefined) return null;
  if (/^-?\d+$/.test(a1)) return { code: Number(a1), ...(atom(node, 2) !== undefined ? { name: atom(node, 2)! } : {}) };
  return { name: a1 };
}

/** Resolves net references to IR net ids, creating nets on first sight in the name dialect. */
class NetIndex {
  readonly nets: NetDefinition[] = [];
  private byCode = new Map<number, string>();
  private byName = new Map<string, string>();
  private classes: EcadRules['netClasses'];
  constructor(classes: EcadRules['netClasses']) {
    this.classes = classes;
  }
  add(code: number, name: string): string {
    const id = uuidv5(`net/${name}`);
    if (!this.byName.has(name)) {
      this.byName.set(name, id);
      this.nets.push({ id, code, name, padIds: [], netClass: netClassFor(name, this.classes) });
    }
    this.byCode.set(code, id);
    return id;
  }
  resolve(node: SexpNode[] | undefined): string | null {
    const ref = netRef(node);
    if (!ref) return null;
    if (ref.code !== undefined) {
      if (ref.code === 0) return null;
      const known = this.byCode.get(ref.code);
      if (known) return known;
      if (ref.name) return this.add(ref.code, ref.name);
      return null;
    }
    if (!ref.name) return null;
    const known = this.byName.get(ref.name);
    if (known) return known;
    return this.add(this.nets.length + 1, ref.name);
  }
}

const COPPER_TYPES = new Set(['signal', 'power', 'mixed', 'jumper']);
const CANONICAL_KIND: [RegExp, LayerKind][] = [
  [/\.Cu$/, 'copper'],
  [/\.SilkS$/, 'silk'],
  [/\.Mask$/, 'mask'],
  [/\.Paste$/, 'paste'],
  [/\.CrtYd$/, 'courtyard'],
  [/\.Fab$/, 'fab'],
  [/^Edge\.Cuts$/, 'edge'],
  [/\.Adhes$/, 'adhesive'],
];

function readLayers(block: SexpNode[]): LayerDefinition[] {
  const out: LayerDefinition[] = [];
  for (const l of block.slice(1)) {
    if (!isList(l)) continue;
    // (ordinal "canonical" type ["user name"]): items always reference the canonical
    // name; the user name is what KiCad shows and what its Specctra exporter emits
    const ordinal = num(l, 0);
    const name = atom(l, 1);
    const type = atom(l, 2);
    const userName = atom(l, 3);
    if (ordinal === undefined || !name) continue;
    let kind: LayerKind = 'user';
    if (type && COPPER_TYPES.has(type)) kind = 'copper';
    else for (const [re, k] of CANONICAL_KIND) if (re.test(name)) kind = k;
    let side: 'front' | 'back' | undefined;
    if (kind === 'copper') {
      if (ordinal === 0) side = 'front';
      else if (ordinal === 31 || ordinal === 2) side = 'back';
    } else if (name.startsWith('F.')) side = 'front';
    else if (name.startsWith('B.')) side = 'back';
    out.push({ id: name, ordinal, kind, ...(side ? { side } : {}), ...(userName && userName !== name ? { userName } : {}) });
  }
  return out;
}

interface LayerTable {
  copper: string[];
  front: string;
  back: string;
  byCanonical: Map<string, string>;
}

function layerTable(layers: LayerDefinition[]): LayerTable {
  // stack order from the names, not the numbers: KiCad's legacy and current numberings disagree (add-multilayer-layout D1)
  const named = copperStack(layers);
  const copper = [...named, ...layers.filter((l) => l.kind === 'copper' && !named.includes(l.id)).map((l) => l.id)];
  const front = layers.find((l) => l.kind === 'copper' && l.side === 'front')?.id ?? 'F.Cu';
  const back = layers.find((l) => l.kind === 'copper' && l.side === 'back')?.id ?? 'B.Cu';
  const byCanonical = new Map<string, string>();
  for (const l of layers) {
    byCanonical.set(l.id, l.id);
    if (l.userName) byCanonical.set(l.userName, l.id);
  }
  return { copper, front, back, byCanonical };
}

/** Expand a KiCad layer token list (`*.Cu`, `F&B.Cu`, names) to copper layer ids. */
function copperLayersOf(tokens: string[], t: LayerTable): string[] {
  const out = new Set<string>();
  for (const tok of tokens) {
    if (tok === '*.Cu') for (const c of t.copper) out.add(c);
    else if (tok === 'F&B.Cu') {
      out.add(t.front);
      out.add(t.back);
    } else {
      const id = t.byCanonical.get(tok) ?? tok;
      if (t.copper.includes(id)) out.add(id);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------- graphics

interface Seg {
  a: Point;
  b: Point;
}

/** Points along an arc through three points, start → end via mid, ≤ 5° steps. */
export function arcPoints(a: Point, mid: Point, b: Point): Point[] {
  const d = 2 * (a.x * (mid.y - b.y) + mid.x * (b.y - a.y) + b.x * (a.y - mid.y));
  if (Math.abs(d) < 1e-9) return [a, b];
  const ux = ((a.x ** 2 + a.y ** 2) * (mid.y - b.y) + (mid.x ** 2 + mid.y ** 2) * (b.y - a.y) + (b.x ** 2 + b.y ** 2) * (a.y - mid.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (b.x - mid.x) + (mid.x ** 2 + mid.y ** 2) * (a.x - b.x) + (b.x ** 2 + b.y ** 2) * (mid.x - a.x)) / d;
  const r = Math.hypot(a.x - ux, a.y - uy);
  const ang = (p: Point) => Math.atan2(p.y - uy, p.x - ux);
  const a0 = ang(a);
  const am = ang(mid);
  const a1 = ang(b);
  // sweep direction: the one that passes through mid
  const ccw = (from: number, to: number) => ((to - from) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const sweepPos = ccw(a0, a1);
  const midPos = ccw(a0, am);
  const positive = midPos <= sweepPos;
  const sweep = positive ? sweepPos : -(2 * Math.PI - sweepPos);
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (5 * (Math.PI / 180))));
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + (sweep * i) / steps;
    out.push({ x: Math.round(ux + r * Math.cos(t)), y: Math.round(uy + r * Math.sin(t)) });
  }
  out[0] = a;
  out[out.length - 1] = b;
  return out;
}

/** Segments and closed shapes from one graphic record (fp_* or gr_*), in the record's own frame. */
function graphicGeometry(g: SexpNode[]): { segs: Seg[]; closed: Polygon[] } {
  const head = String(g[0]);
  const kind = head.replace(/^(fp|gr)_/, '');
  const segs: Seg[] = [];
  const closed: Polygon[] = [];
  const s = pt(child(g, 'start'));
  const e = pt(child(g, 'end'));
  if (kind === 'line' && s && e) segs.push({ a: s, b: e });
  else if (kind === 'rect' && s && e) closed.push(rectFromBounds(Math.min(s.x, e.x), Math.min(s.y, e.y), Math.max(s.x, e.x), Math.max(s.y, e.y)));
  else if (kind === 'circle') {
    const c = pt(child(g, 'center'));
    if (c && e) closed.push(circle(c.x, c.y, 2 * Math.round(Math.hypot(e.x - c.x, e.y - c.y))));
  } else if (kind === 'arc' && s && e) {
    const m = pt(child(g, 'mid'));
    const pts = m ? arcPoints(s, m, e) : [s, e];
    for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: pts[i]!, b: pts[i + 1]! });
  } else if (kind === 'poly') {
    const ptsNode = child(g, 'pts');
    const pts: Point[] = [];
    for (const xy of ptsNode ? children(ptsNode, 'xy') : []) {
      const p = pt(xy);
      if (p) pts.push(p);
    }
    if (pts.length >= 3) closed.push({ outer: pts, holes: [] });
  }
  return { segs, closed };
}

const layerOf = (g: SexpNode[]): string | undefined => atom(child(g, 'layer'), 1);

/** Union of all graphics on the given layers into polygons (segments chained into loops). */
function graphicsOutline(graphics: SexpNode[][], layers: Set<string>, lossy: string[], what: string): Polygon[] {
  const segs: Seg[] = [];
  const closed: Polygon[] = [];
  for (const g of graphics) {
    const l = layerOf(g);
    if (!l || !layers.has(l)) continue;
    const geo = graphicGeometry(g);
    segs.push(...geo.segs);
    closed.push(...geo.closed);
  }
  // 10 µm: KiCad's DRC accepts outlines with gaps of a few µm from legacy imperial boards; nearest-endpoint matching keeps arc vertices apart
  const { loops, open } = chainLoops(segs, mmToNm(0.01));
  for (const loop of loops) if (loop.length >= 3) closed.push({ outer: loop, holes: [] });
  if (open) lossy.push(`${what}: ${open} unclosed segment chain(s) ignored`);
  return closed;
}

// ---------------------------------------------------------------- pads

function padCopper(shape: PadShape, w: Nm, h: Nm, pad: SexpNode[], lossy: string[], where: string): Polygon {
  switch (shape) {
    case 'circle':
      return circle(0, 0, w);
    case 'oval':
      return stadium(0, 0, w, h);
    case 'roundrect': {
      const ratio = num(child(pad, 'roundrect_rratio'), 1) ?? 0.25;
      return roundRect(0, 0, w, h, Math.round(ratio * Math.min(w, h)));
    }
    case 'trapezoid':
      lossy.push(`${where}: trapezoid pad read as its bounding rectangle`);
      return rect(0, 0, w, h);
    case 'chamfered':
      return rect(0, 0, w, h); // superset of the copper; chamfers are decorative for clearance purposes
    case 'custom': {
      const prims = child(pad, 'primitives');
      const parts: Polygon[] = [shape === 'custom' && atom(pad, 3) === 'circle' ? circle(0, 0, w) : rect(0, 0, w, h)];
      let unsupported = 0;
      for (const p of prims ? prims.slice(1) : []) {
        if (!isList(p)) continue;
        const head = String(p[0]);
        if (head === 'gr_poly' || head === 'gr_rect' || head === 'gr_circle') parts.push(...graphicGeometry(p).closed);
        else if (head === 'gr_line') {
          const s = pt(child(p, 'start'));
          const e = pt(child(p, 'end'));
          const wd = nm(child(child(p, 'stroke') ?? [], 'width'), 1) ?? nm(child(p, 'width'), 1) ?? 0;
          if (s && e) parts.push(capsule(s, e, wd));
        } else unsupported++;
      }
      if (unsupported) lossy.push(`${where}: ${unsupported} custom-pad primitive(s) of unsupported kind ignored`);
      return union(parts)[0] ?? rect(0, 0, w, h);
    }
    default:
      return rect(0, 0, w, h);
  }
}

function readPad(pad: SexpNode[], fp: { id: string; at: Point; rot: Mdeg; ref: string }, t: LayerTable, nets: NetIndex, lossy: string[], ordinal: number): PadDefinition | null {
  const number = atom(pad, 1) ?? '';
  const type = (atom(pad, 2) ?? 'smd') as PadType;
  const shapeTok = atom(pad, 3) ?? 'rect';
  const shape = (shapeTok === 'chamfered_rect' ? 'chamfered' : shapeTok) as PadShape;
  const at = child(pad, 'at');
  const local = pt(at);
  const size = child(pad, 'size');
  const w = nm(size, 1) ?? 0;
  const h = nm(size, 2) ?? w;
  if (!local) return null;
  const absRot = normMdeg(degToMdeg(num(at, 3) ?? 0));
  const abs = rotatePoint(local, fp.rot);
  const position = { x: fp.at.x + abs.x, y: fp.at.y + abs.y };
  const layersNode = child(pad, 'layers');
  const layers = copperLayersOf((layersNode ?? []).slice(1).filter((x): x is string => typeof x === 'string'), t);
  const where = `${fp.ref}.${number}`;
  const shapePoly = padCopper(shape, w, h, pad, lossy, where);
  const copper = placeLocal(shapePoly, position, absRot);
  const drillNode = child(pad, 'drill');
  let drill: PadDefinition['drill'];
  if (drillNode) {
    if (atom(drillNode, 1) === 'oval') {
      const dw = nm(drillNode, 2) ?? 0;
      const dh = nm(drillNode, 3) ?? dw;
      drill = { d: Math.max(dw, dh), slot: { w: dw, h: dh } };
    } else {
      drill = { d: nm(drillNode, 1) ?? 0 };
    }
    const off = pt(child(drillNode, 'offset'));
    if (off) drill.offset = off;
  }
  const netId = nets.resolve(child(pad, 'net'));
  const pinFunction = atom(child(pad, 'pinfunction'), 1);
  const pinType = atom(child(pad, 'pintype'), 1);
  return {
    id: uuidv5(`pad/${fp.id}/${number}/${ordinal}`),
    number,
    netId,
    type,
    shape,
    at: position,
    rotation: absRot,
    size: { w, h },
    layers,
    ...(drill ? { drill } : {}),
    copper,
    ...(pinFunction ? { pinFunction } : {}),
    ...(pinType ? { pinType } : {}),
  };
}

// ---------------------------------------------------------------- footprints

function readFootprint(block: Block, t: LayerTable, nets: NetIndex, lossy: string[]): ComponentInstance | null {
  const fp = first(block.text);
  if (!fp) return null;
  const libId = atom(fp, 1) ?? '';
  const id = atom(child(fp, 'uuid'), 1) ?? atom(child(fp, 'tstamp'), 1) ?? uuidv5(`footprint/${block.start}`);
  const atNode = child(fp, 'at');
  const at = pt(atNode) ?? { x: 0, y: 0 };
  const rot = normMdeg(degToMdeg(num(atNode, 3) ?? 0));
  const layer = atom(child(fp, 'layer'), 1) ?? t.front;
  const side: 'front' | 'back' = (t.byCanonical.get(layer) ?? layer) === t.back || layer === 'B.Cu' ? 'back' : 'front';
  let reference = '';
  let value = '';
  for (const p of children(fp, 'property')) {
    const key = atom(p, 1);
    if (key === 'Reference') reference = atom(p, 2) ?? '';
    else if (key === 'Value') value = atom(p, 2) ?? '';
  }
  // KiCad 8 wrote (fp_text reference "R1" …) instead of properties
  if (!reference) for (const ft of children(fp, 'fp_text')) if (atom(ft, 1) === 'reference') reference = atom(ft, 2) ?? '';
  if (!value) for (const ft of children(fp, 'fp_text')) if (atom(ft, 1) === 'value') value = atom(ft, 2) ?? '';
  const attr = new Set((child(fp, 'attr') ?? []).slice(1).filter((x): x is string => typeof x === 'string'));
  const locked = atom(child(fp, 'locked'), 1) === 'yes' || fp.includes('locked');
  const graphics = fp.filter((n): n is SexpNode[] => isList(n) && /^fp_(line|rect|circle|arc|poly)$/.test(String(n[0])));
  const crtLayers = new Set([side === 'back' ? 'B.CrtYd' : 'F.CrtYd']);
  const fabLayers = new Set([side === 'back' ? 'B.Fab' : 'F.Fab']);
  const courtLocal = graphicsOutline(graphics, crtLayers, lossy, `${reference} courtyard`);
  const bodyLocal = graphicsOutline(graphics, fabLayers, [], `${reference} body`);
  const place = (polys: Polygon[]): Polygon | null => {
    if (!polys.length) return null;
    const placed = polys.map((p) => placeLocal(p, at, rot));
    const u = union(placed);
    if (u.length === 1) return u[0]!;
    // disjoint courtyard pieces: use their common bounding box
    const b = bboxOf(placed);
    return rectFromBounds(b.minX, b.minY, b.maxX, b.maxY);
  };
  const footprint: FootprintDefinition = { libId, courtyard: place(courtLocal), body: place(bodyLocal) };
  const pads: PadDefinition[] = [];
  let ordinal = 0;
  for (const p of children(fp, 'pad')) {
    const pad = readPad(p, { id, at, rot, ref: reference }, t, nets, lossy, ordinal++);
    if (pad) pads.push(pad);
  }
  // schematic identity (add-reuse-placer): the symbol path survives a footprint swap; the sheet names the subsystem the designer drew
  const symbolPath = atom(child(fp, 'path'), 1);
  const sheetName = atom(child(fp, 'sheetname'), 1);
  const sheetFile = atom(child(fp, 'sheetfile'), 1);
  return {
    id,
    reference,
    value,
    footprint,
    pads,
    at,
    rotation: rot,
    attributes: {
      side,
      locked,
      throughHole: attr.has('through_hole'),
      excludeFromBom: attr.has('exclude_from_bom'),
      dnp: attr.has('dnp'),
    },
    semanticRoles: [],
    ...(symbolPath ? { symbolPath } : {}),
    ...(sheetName !== undefined ? { sheet: { name: sheetName, ...(sheetFile ? { file: sheetFile } : {}) } } : {}),
  };
}

// ---------------------------------------------------------------- zones

function readZone(block: Block, t: LayerTable, nets: NetIndex): { zone: CopperZone; keepout: Keepout | null } | null {
  const z = first(block.text);
  if (!z) return null;
  const id = atom(child(z, 'uuid'), 1) ?? atom(child(z, 'tstamp'), 1) ?? uuidv5(`zone/${block.start}`);
  const netId = nets.resolve(child(z, 'net'));
  const single = atom(child(z, 'layer'), 1);
  const multi = (child(z, 'layers') ?? []).slice(1).filter((x): x is string => typeof x === 'string');
  const layers = copperLayersOf(single ? [single] : multi, t);
  const poly = child(z, 'polygon');
  const ptsNode = poly ? child(poly, 'pts') : undefined;
  const outer: Point[] = [];
  for (const xy of ptsNode ? children(ptsNode, 'xy') : []) {
    const p = pt(xy);
    if (p) outer.push(p);
  }
  const fill = child(z, 'fill');
  const thermalGap = fill ? nm(child(fill, 'thermal_gap'), 1) : undefined;
  const thermalBridge = fill ? nm(child(fill, 'thermal_bridge_width'), 1) : undefined;
  const cp = child(z, 'connect_pads');
  const keepoutNode = child(z, 'keepout');
  const zone: CopperZone = {
    id,
    netId,
    layers,
    outline: { outer, holes: [] },
    priority: num(child(z, 'priority'), 1) ?? 0,
    clearanceNm: (cp ? nm(child(cp, 'clearance'), 1) : undefined) ?? 0,
    thermal: thermalGap !== undefined && thermalBridge !== undefined ? { gapNm: thermalGap, bridgeNm: thermalBridge } : null,
    isKeepout: !!keepoutNode,
    definitionText: stripChildren(block.text, 'filled_polygon'),
  };
  let keepout: Keepout | null = null;
  if (keepoutNode) {
    const prohibits: Keepout['prohibits'] = [];
    const map: Record<string, Keepout['prohibits'][number]> = { tracks: 'tracks', vias: 'vias', pads: 'pads', copperpour: 'copper', footprints: 'footprints' };
    for (const k of keepoutNode.slice(1)) {
      if (!isList(k)) continue;
      const what = map[String(k[0])];
      if (what && atom(k, 1) === 'not_allowed') prohibits.push(what);
    }
    keepout = { id, polygon: zone.outline, layers, prohibits };
  }
  return { zone, keepout };
}

// ---------------------------------------------------------------- project rules

const DEFAULT_RULES = { clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, copperEdge: 0.5 };

function readProject(projectText: string | undefined, warnings: string[]): { rules: DesignRules; classes: EcadRules['netClasses'] } {
  let pro: Record<string, unknown> = {};
  if (projectText) {
    try {
      pro = JSON.parse(projectText) as Record<string, unknown>;
    } catch (e) {
      warnings.push(`project file is not valid JSON (${(e as Error).message}); KiCad default rules assumed`);
    }
  }
  const ns = (pro.net_settings ?? {}) as { classes?: Record<string, unknown>[]; netclass_patterns?: { pattern: string; netclass: string }[]; netclass_assignments?: Record<string, string> };
  const ds = ((pro.board as Record<string, unknown> | undefined)?.design_settings ?? {}) as { rules?: Record<string, number> };
  const classesRaw = ns.classes ?? [];
  const def = (classesRaw.find((c) => c.name === 'Default') ?? classesRaw[0] ?? {}) as Record<string, number | string>;
  const n = (v: unknown, d: number): Nm => mmToNm(typeof v === 'number' ? v : d);
  const r = ds.rules ?? {};
  const sevRaw = (ds as { rule_severities?: Record<string, string> }).rule_severities ?? {};
  const severities: Record<string, 'error' | 'warning' | 'ignore' | 'exclusion'> = {};
  for (const [k, v] of Object.entries(sevRaw)) if (v === 'error' || v === 'warning' || v === 'ignore' || v === 'exclusion') severities[k] = v;
  const rules: DesignRules = {
    severities,
    clearanceNm: n(def.clearance, DEFAULT_RULES.clearance),
    trackWidthNm: n(def.track_width, DEFAULT_RULES.track_width),
    viaDiameterNm: n(def.via_diameter, DEFAULT_RULES.via_diameter),
    viaDrillNm: n(def.via_drill, DEFAULT_RULES.via_drill),
    copperEdgeClearanceNm: n(r.min_copper_edge_clearance, DEFAULT_RULES.copperEdge),
    ...(typeof r.min_track_width === 'number' ? { minTrackWidthNm: mmToNm(r.min_track_width) } : {}),
    ...(typeof r.min_via_diameter === 'number' ? { minViaDiameterNm: mmToNm(r.min_via_diameter) } : {}),
    ...(typeof r.min_through_hole_diameter === 'number' ? { minViaDrillNm: mmToNm(r.min_through_hole_diameter) } : {}),
    netClasses: {},
  };
  const classes: EcadRules['netClasses'] = [];
  const patterns = ns.netclass_patterns ?? [];
  for (const c of classesRaw) {
    const name = String(c.name ?? '');
    if (!name) continue;
    const entry: EcadRules['netClasses'][number] = {
      name,
      ...(typeof c.clearance === 'number' ? { clearanceNm: mmToNm(c.clearance) } : {}),
      ...(typeof c.track_width === 'number' ? { trackWidthNm: mmToNm(c.track_width) } : {}),
      ...(typeof c.via_diameter === 'number' ? { viaDiameterNm: mmToNm(c.via_diameter) } : {}),
      ...(typeof c.via_drill === 'number' ? { viaDrillNm: mmToNm(c.via_drill) } : {}),
      ...(typeof c.diff_pair_gap === 'number' ? { diffPairGapNm: mmToNm(c.diff_pair_gap) } : {}),
      nets: Array.isArray(c.nets) ? (c.nets as string[]) : [],
      patterns: patterns.filter((p) => p.netclass === name).map((p) => p.pattern),
    };
    classes.push(entry);
    if (name !== 'Default') {
      rules.netClasses[name] = {
        ...(entry.clearanceNm !== undefined ? { clearanceNm: entry.clearanceNm } : {}),
        ...(entry.trackWidthNm !== undefined ? { trackWidthNm: entry.trackWidthNm } : {}),
        ...(entry.viaDiameterNm !== undefined ? { viaDiameterNm: entry.viaDiameterNm } : {}),
        ...(entry.viaDrillNm !== undefined ? { viaDrillNm: entry.viaDrillNm } : {}),
        nets: [...entry.nets, ...entry.patterns],
      };
    }
  }
  return { rules, classes };
}

function netClassFor(name: string, classes: EcadRules['netClasses']): string {
  for (const c of classes) {
    if (c.name === 'Default') continue;
    if (c.nets.includes(name)) return c.name;
    for (const p of c.patterns) {
      const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      if (re.test(name)) return c.name;
    }
  }
  return 'Default';
}

function readDru(druText: string | undefined): EcadRules['druRules'] {
  if (!druText) return [];
  const out: EcadRules['druRules'] = [];
  for (const b of childBlocksOfDru(druText)) {
    if (b.head !== 'rule') continue;
    const r = first(b.text);
    if (!r) continue;
    const cond = child(r, 'condition');
    const cons = children(r, 'constraint').map((c) => c.slice(1).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).join('; ');
    out.push({ name: atom(r, 1) ?? '', condition: cond ? (atom(cond, 1) ?? null) : null, constraint: cons, text: b.text });
  }
  return out;
}

/** A `.kicad_dru` is a sequence of top-level lists, not one root list. */
function childBlocksOfDru(text: string): Block[] {
  return childBlocks(`(dru\n${text}\n)`).map((b) => ({ ...b, start: b.start - 5, end: b.end - 5 }));
}

// ---------------------------------------------------------------- import

const MODELLED_HEADS = new Set(['version', 'generator', 'generator_version', 'general', 'paper', 'title_block', 'layers', 'setup', 'property', 'net', 'footprint', 'segment', 'arc', 'via', 'zone']);

export function importBoard(input: ImportInput): ImportResult {
  const warnings: string[] = [];
  const lossy: string[] = [];
  const text = input.boardText;
  const blocks = topLevelBlocks(text);
  const version = num(first(blocks.find((b) => b.head === 'version')?.text ?? '(version 0)'), 1) ?? 0;
  if (version > MAX_BOARD_VERSION) throw new UnsupportedBoardVersion(version);
  if (version < MIN_BOARD_VERSION) warnings.push(`board file version ${version} predates KiCad 8; run kicad-cli pcb upgrade first for full fidelity`);

  const layersBlock = blocks.find((b) => b.head === 'layers');
  const layers = layersBlock ? readLayers(first(layersBlock.text) ?? []) : [];
  const t = layerTable(layers);

  const general = first(blocks.find((b) => b.head === 'general')?.text ?? '(general)');
  const thicknessNm = general ? nm(child(general, 'thickness'), 1) : undefined;

  // nets: from the table when the file has one (code dialect), else discovered on the objects (name dialect)
  const { rules, classes } = readProject(input.projectText, warnings);
  const netIndex = new NetIndex(classes);
  let netDialect: 'code' | 'name' = 'name';
  for (const b of blocks) {
    if (b.head !== 'net') continue;
    netDialect = 'code';
    const ref = netRef(first(b.text));
    if (ref?.code !== undefined && ref.code > 0 && ref.name !== undefined) netIndex.add(ref.code, ref.name);
  }
  const nets = netIndex.nets;

  // footprints
  const components: ComponentInstance[] = [];
  const seenFootprintIds = new Set<string>();
  for (const b of blocks) {
    if (b.head !== 'footprint') continue;
    let c = readFootprint(b, t, netIndex, lossy);
    if (!c) continue;
    // KiCad tolerates two footprints sharing a uuid (copy-paste in older files); every
    // id-keyed map here does not, and the second part would silently take the first one's place
    if (seenFootprintIds.has(c.id)) {
      const id = uuidv5(`footprint/${c.id}/${components.length}`);
      warnings.push(`${c.reference || id}: duplicate footprint uuid ${c.id}; re-keyed as ${id}`);
      c = { ...c, id, pads: c.pads.map((p, i) => ({ ...p, id: uuidv5(`pad/${id}/${p.number}/${i}`) })) };
    }
    seenFootprintIds.add(c.id);
    components.push(c);
    for (const p of c.pads) if (p.netId) nets.find((n) => n.id === p.netId)?.padIds.push(p.id);
    if (!c.footprint.courtyard) warnings.push(`${c.reference || c.id}: no courtyard drawn`);
  }

  // outline
  const boardGraphics = blocks.filter((b) => /^gr_(line|rect|circle|arc|poly)$/.test(b.head)).map((b) => first(b.text)).filter((g): g is SexpNode[] => !!g);
  const edgePolys = graphicsOutline(boardGraphics, new Set(['Edge.Cuts']), lossy, 'outline');
  let outline: Polygon;
  let cutouts: Polygon[] = [];
  if (edgePolys.length) {
    const sorted = [...edgePolys].sort((a, b) => area(b) - area(a));
    outline = sorted[0]!;
    cutouts = sorted.slice(1);
  } else {
    const b = bboxOf(components.flatMap((c) => c.pads.map((p) => p.copper)));
    outline = Number.isFinite(b.minX) ? rectFromBounds(b.minX, b.minY, b.maxX, b.maxY) : rectFromBounds(0, 0, 0, 0);
    lossy.push('outline: no closed Edge.Cuts loop; using the copper bounding box');
  }

  // copper
  const segments: TrackSegment[] = [];
  const arcs: TrackArc[] = [];
  const vias: Via[] = [];
  const zones: CopperZone[] = [];
  const keepouts: Keepout[] = [];
  const preserved: PreservedBlock[] = [];
  for (const b of blocks) {
    if (b.head === 'segment' || b.head === 'arc') {
      const s = first(b.text);
      if (!s) continue;
      const a = pt(child(s, 'start'));
      const e = pt(child(s, 'end'));
      const width = nm(child(s, 'width'), 1) ?? 0;
      const layer = atom(child(s, 'layer'), 1) ?? t.front;
      const netId = netIndex.resolve(child(s, 'net')) ?? '';
      const id = atom(child(s, 'uuid'), 1) ?? atom(child(s, 'tstamp'), 1) ?? uuidv5(`${b.head}/${b.start}`);
      if (!a || !e) continue;
      if (b.head === 'segment') segments.push({ id, netId, layer, a, b: e, width });
      else {
        const mid = pt(child(s, 'mid')) ?? a;
        arcs.push({ id, netId, layer, a, mid, b: e, width });
      }
    } else if (b.head === 'via') {
      const v = first(b.text);
      if (!v) continue;
      const at = pt(child(v, 'at'));
      if (!at) continue;
      const ls = (child(v, 'layers') ?? []).slice(1).filter((x): x is string => typeof x === 'string');
      vias.push({
        id: atom(child(v, 'uuid'), 1) ?? atom(child(v, 'tstamp'), 1) ?? uuidv5(`via/${b.start}`),
        netId: netIndex.resolve(child(v, 'net')) ?? '',
        at,
        size: nm(child(v, 'size'), 1) ?? 0,
        drill: nm(child(v, 'drill'), 1) ?? 0,
        layers: [t.byCanonical.get(ls[0] ?? 'F.Cu') ?? ls[0] ?? t.front, t.byCanonical.get(ls[1] ?? 'B.Cu') ?? ls[1] ?? t.back],
      });
    } else if (b.head === 'zone') {
      const z = readZone(b, t, netIndex);
      if (!z) continue;
      zones.push(z.zone);
      if (z.keepout) keepouts.push(z.keepout);
    } else if (!MODELLED_HEADS.has(b.head)) {
      if (/^gr_/.test(b.head) && first(b.text) && layerOf(first(b.text)!) === 'Edge.Cuts') continue; // consumed by the outline
      preserved.push({ head: b.head, text: b.text });
    }
  }

  const design: PcbDesign = {
    schemaVersion: IR_SCHEMA_VERSION,
    designId: uuidv5(`design/${input.boardPath}`),
    source: {
      files: { board: input.boardPath, ...(input.projectPath ? { project: input.projectPath } : {}), ...(input.druPath ? { dru: input.druPath } : {}) },
      kicadVersion: input.kicadVersion ?? 'unknown',
      boardFileVersion: version,
      netDialect,
      importedAt: input.now ?? new Date().toISOString(),
      contentHash: '',
    },
    board: { outline, cutouts, layers, ...(thicknessNm !== undefined ? { thicknessNm } : {}), keepouts, fabricationProfile: input.fabricationProfile ?? defaultProfileIdFor(copperStack(layers).length), rules },
    components,
    nets,
    constraints: [],
    placement: {
      components: components.map((c) => ({ id: c.id, at: c.at, rotation: c.rotation, side: c.attributes.side })),
      lockedComponentIds: components.filter((c) => c.attributes.locked).map((c) => c.id),
    },
    routing: { segments, arcs, vias, zones },
    preserved,
    lossy,
  };
  design.source.contentHash = hashDesign(design);
  return {
    design,
    ecad: { netClasses: classes, druRules: readDru(input.druText), lockedComponentIds: design.placement.lockedComponentIds },
    warnings,
  };
}

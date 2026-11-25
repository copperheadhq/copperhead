import { createHash } from 'node:crypto';
import { child, children, isList, parseSexp, type SexpNode } from '../kicad/sexp.js';
import { childSpans } from '../kicad/spans.js';
import { contentHash } from './canonical.js';
import { rotatePoint, rotationMdeg, rotationOf, type Rotation } from './geometry.js';
import { arcCircle, nmOf, type Pt } from './textconv.js';
import type { FootprintDefinition, LayoutInput, Quantity } from './types.generated.js';

/**
 * A KiCad board compiled directly into the layout input of RFC 11 Section 6.9,
 * as Section 5.1 allows an import adapter that does not yet pass through the
 * kernel: the same schema, identifiers derived under RFC 3 Section 4.2, the
 * imported file named by its hash in place of a graph snapshot, and every
 * placement owned by the import adapter (RFC 12 Section 9.5).
 *
 * What the adapter cannot represent faithfully is listed in the board's
 * `lossy` field rather than approximated silently (RFC 3 Section 4).
 */

type List = SexpNode[];
type Footprint = FootprintDefinition;
type Component = LayoutInput['components'][string];
type Trace = LayoutInput['routing']['traces'][string];
type Via = LayoutInput['routing']['vias'][string];
type Zone = LayoutInput['routing']['zones'][string];
type LayerEntry = LayoutInput['board']['layers'][number];

/** The import adapter and the configuration its output is a function of. */
export const ADAPTER = { adapter: 'copperhead.kicad-import', version: 1 } as const;

/** RFC 3 Section 4.2: the Copperhead EIR root namespace. */
const ROOT_NAMESPACE = '453c7e27-7e71-4d31-af3e-9da6714fc2ba';

/** A name-based UUID, version 5 (RFC 9562): SHA-1 of the namespace and the name. */
export function uuid5(namespace: string, name: string): string {
  const h = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const KIND: Record<string, string> = {
  CMP: 'component',
  NET: 'net',
  PIN: 'pin',
  PCB: 'board',
  LYR: 'layer',
  TRC: 'trace',
  VIA: 'via',
  ZONE: 'zone',
};

/** Derived identifiers for one project (RFC 3 Section 4.2). */
export class Identifiers {
  private readonly project: string;
  constructor(projectId: string) {
    this.project = uuid5(ROOT_NAMESPACE, projectId);
  }
  uuid(prefix: string, path: string): string {
    return uuid5(this.project, `${KIND[prefix]}:${path}`);
  }
  id(prefix: string, path: string): string {
    return `${prefix}-${this.uuid(prefix, path).replace(/-/g, '').slice(0, 12)}`;
  }
}

function atom(node: List | undefined, i: number): string | undefined {
  const v = node?.[i];
  return typeof v === 'string' ? v : undefined;
}

function pt(node: List | undefined): Pt {
  return [nmOf(atom(node, 1)), nmOf(atom(node, 2))];
}

const xy = ([x, y]: Pt) => ({ x, y });

function rotationOfDegrees(text: string | undefined): Rotation {
  return rotationOf(Math.round(Number(text ?? '0') * 1000));
}

function mmQuantity(text: string | undefined): Quantity | undefined {
  return text === undefined ? undefined : { kind: 'scalar', value: String(Number(text)), unit: 'mm' };
}

function ringOf(points: Pt[]): Array<{ x: number; y: number }> | undefined {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out.length >= 3 ? out.map(xy) : undefined;
}

/** Points along an arc, no chord farther than `tolerance` from the curve. */
function sampleArc(start: Pt, mid: Pt, end: Pt, tolerance: number): Pt[] {
  const c = arcCircle(start, mid, end);
  if (!c) return [start, end];
  const step = c.r > tolerance ? 2 * Math.acos(1 - tolerance / c.r) : Math.PI / 2;
  const n = Math.max(2, Math.ceil(c.sweep / step));
  const out: Pt[] = [start];
  for (let k = 1; k < n; k++) {
    const a = c.a0 + (c.forward ? 1 : -1) * (c.sweep * k) / n;
    out.push([Math.round(c.ux + c.r * Math.cos(a)), Math.round(c.uy + c.r * Math.sin(a))]);
  }
  out.push(end);
  return out;
}

function polygonArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

/** Closed rings from edge-cut drawings, chained end to end. */
function edgeRings(root: List, tolerance: number): { rings: Pt[][]; complete: boolean } {
  const rings: Pt[][] = [];
  const edges: Pt[][] = [];
  for (const node of root) {
    if (!isList(node) || typeof node[0] !== 'string' || !node[0].startsWith('gr_')) continue;
    if (atom(child(node, 'layer'), 1) !== 'Edge.Cuts') continue;
    const kind = node[0];
    if (kind === 'gr_rect') {
      const [x1, y1] = pt(child(node, 'start'));
      const [x2, y2] = pt(child(node, 'end'));
      rings.push([
        [Math.min(x1, x2), Math.min(y1, y2)],
        [Math.max(x1, x2), Math.min(y1, y2)],
        [Math.max(x1, x2), Math.max(y1, y2)],
        [Math.min(x1, x2), Math.max(y1, y2)],
      ]);
    } else if (kind === 'gr_poly') {
      rings.push(children(child(node, 'pts') ?? [], 'xy').map(pt));
    } else if (kind === 'gr_circle') {
      const c = pt(child(node, 'center'));
      const e = pt(child(node, 'end'));
      const r = Math.hypot(e[0] - c[0], e[1] - c[1]);
      const n = Math.max(8, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tolerance / Math.max(r, tolerance)))));
      rings.push(
        Array.from({ length: n }, (_, k) => [
          Math.round(c[0] + r * Math.cos((2 * Math.PI * k) / n)),
          Math.round(c[1] + r * Math.sin((2 * Math.PI * k) / n)),
        ]) as Pt[],
      );
    } else if (kind === 'gr_line') {
      edges.push([pt(child(node, 'start')), pt(child(node, 'end'))]);
    } else if (kind === 'gr_arc' && child(node, 'mid')) {
      edges.push(sampleArc(pt(child(node, 'start')), pt(child(node, 'mid')), pt(child(node, 'end')), tolerance));
    }
  }
  // Chain open edges into rings: each step takes an edge that starts, or ends, where the chain ends.
  const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
  let complete = true;
  const pool = edges.slice();
  while (pool.length) {
    const chain = pool.shift()!.slice();
    let closed = same(chain[0]!, chain[chain.length - 1]!);
    while (!closed) {
      const tail = chain[chain.length - 1]!;
      const i = pool.findIndex((e) => same(e[0]!, tail) || same(e[e.length - 1]!, tail));
      if (i < 0) break;
      const e = pool.splice(i, 1)[0]!;
      const next = same(e[0]!, tail) ? e : e.slice().reverse();
      chain.push(...next.slice(1));
      closed = same(chain[0]!, chain[chain.length - 1]!);
    }
    if (closed) rings.push(chain.slice(0, -1));
    else complete = false;
  }
  return { rings, complete };
}

/** The copper of one pad in the footprint frame. */
function padCopper(shape: string, at: Pt, rot: Rotation, w: number, h: number): Pt[] {
  let local: Pt[];
  if (shape === 'circle' || shape === 'oval') {
    const r = Math.min(w, h) / 2;
    const half = (Math.max(w, h) - Math.min(w, h)) / 2;
    const n = 8;
    local = [];
    for (const [side, from] of [
      [1, -Math.PI / 2],
      [-1, Math.PI / 2],
    ] as const) {
      for (let k = 0; k <= n; k++) {
        const a = from + (Math.PI * k) / n;
        const cx = w >= h ? side * half : 0;
        const cy = w >= h ? 0 : -side * half;
        const ax = w >= h ? a : a - Math.PI / 2;
        local.push([Math.round(cx + r * Math.cos(ax)), Math.round(cy + r * Math.sin(ax))]);
      }
    }
  } else {
    const x0 = -Math.floor(w / 2);
    const y0 = -Math.floor(h / 2);
    local = [
      [x0, y0],
      [x0 + w, y0],
      [x0 + w, y0 + h],
      [x0, y0 + h],
    ];
  }
  return local.map(([x, y]) => {
    const [rx, ry] = rotatePoint(x, y, rot);
    return [at[0] + rx, at[1] + ry] as Pt;
  });
}

function footprintDefinition(fp: List, notes: Set<string>): Footprint {
  const fpRot = rotationMdeg(rotationOfDegrees(atom(child(fp, 'at'), 3)));
  const back = atom(child(fp, 'layer'), 1)?.startsWith('B.') ?? false;
  if (back) notes.add('back-side footprint definitions are as KiCad stores them, not normalized to the front view');
  const attr = child(fp, 'attr');
  const mount: Footprint['mount'] = attr?.includes('smd') ? 'smd' : attr?.includes('through_hole') ? 'through_hole' : 'other';
  const pads: Footprint['pads'] = children(fp, 'pad').map((p) => {
    const at = child(p, 'at');
    const pos = pt(at);
    // A board file writes a pad's angle on the board; its angle in the footprint is that less the footprint's.
    const rot = rotationOf(Math.round(Number(atom(at, 3) ?? '0') * 1000) - fpRot);
    const size = child(p, 'size');
    const w = nmOf(atom(size, 1));
    const h = nmOf(atom(size, 2) ?? atom(size, 1));
    const shape = (atom(p, 3) ?? 'rect') as Footprint['pads'][number]['shape'];
    const type = (atom(p, 2) ?? 'smd') as Footprint['pads'][number]['type'];
    const drillNode = child(p, 'drill');
    let drill: Footprint['pads'][number]['drill'];
    if (drillNode) {
      if (atom(drillNode, 1) === 'oval') {
        const dw = nmOf(atom(drillNode, 2));
        const dh = nmOf(atom(drillNode, 3) ?? atom(drillNode, 2));
        drill = { d: Math.min(dw, dh), slot: { w: dw, h: dh } };
      } else {
        drill = { d: nmOf(atom(drillNode, 1)) };
      }
      const offset = child(drillNode, 'offset');
      if (offset) drill.offset = xy(pt(offset));
    }
    if (shape === 'roundrect' || shape === 'trapezoid' || shape === 'chamfered' || shape === 'custom') {
      notes.add('pad copper of roundrect, trapezoid, chamfered, and custom pads is imported as its bounding rectangle');
    }
    const ring = ringOf(padCopper(shape, pos, rot, w, h))!;
    const padLayers = (child(p, 'layers') ?? []).slice(1).filter((x): x is string => typeof x === 'string');
    if (!padLayers.length) throw new Error(`pad ${atom(p, 1) ?? '?'} of ${atom(fp, 1) ?? '?'} names no layer`);
    return {
      number: atom(p, 1) ?? '',
      type,
      shape,
      size: { w, h },
      pose: { x: pos[0], y: pos[1], rot },
      layers: padLayers as [string, ...string[]],
      ...(drill && { drill }),
      copper: { outline: ring as never },
    };
  });
  const def: Footprint = { schema_version: '2.0', lib_id: atom(fp, 1) ?? '', mount, pads };
  const courtyard: Pt[] = [];
  let traced = false;
  for (const g of fp) {
    if (!isList(g) || typeof g[0] !== 'string' || !g[0].startsWith('fp_')) continue;
    if (!/\.CrtYd$/.test(atom(child(g, 'layer'), 1) ?? '')) continue;
    if (g[0] === 'fp_rect' && !traced) {
      const [x1, y1] = pt(child(g, 'start'));
      const [x2, y2] = pt(child(g, 'end'));
      courtyard.push([Math.min(x1, x2), Math.min(y1, y2)], [Math.max(x1, x2), Math.min(y1, y2)], [Math.max(x1, x2), Math.max(y1, y2)], [Math.min(x1, x2), Math.max(y1, y2)]);
      traced = true;
    } else if (g[0] === 'fp_poly' && !traced) {
      courtyard.push(...children(child(g, 'pts') ?? [], 'xy').map(pt));
      traced = true;
    } else {
      for (const k of ['start', 'end', 'mid', 'center']) if (child(g, k)) courtyard.push(pt(child(g, k)));
      notes.add('a courtyard drawn as lines or arcs is imported as its bounding rectangle');
    }
  }
  if (courtyard.length) {
    let ring = courtyard;
    if (!traced || courtyard.length < 3) {
      const xs = courtyard.map((p) => p[0]);
      const ys = courtyard.map((p) => p[1]);
      ring = [
        [Math.min(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.max(...ys)],
        [Math.min(...xs), Math.max(...ys)],
      ];
    }
    const r = ringOf(ring);
    if (r) def.courtyard = { outline: r as never };
  }
  return def;
}

function property(fp: List, name: string): string | undefined {
  for (const p of children(fp, 'property')) if (atom(p, 1) === name) return atom(p, 2);
  for (const t of children(fp, 'fp_text')) if (atom(t, 1) === name.toLowerCase()) return atom(t, 2);
  return undefined;
}

export interface ImportOptions {
  /** The project identifier identifiers are derived under (RFC 3 Section 4.2). */
  projectId: string;
  /** How the imported file is named in the layout input's parent. */
  path: string;
  /** The largest deviation used to write an arc as a ring, in nm (default 1000). */
  arcTolerance?: number;
}

/** Compile a KiCad board's text into a layout input. */
export function importKicadBoard(source: string, options: ImportOptions): LayoutInput {
  const roots = parseSexp(source);
  const root = roots.find((n): n is List => isList(n) && n[0] === 'kicad_pcb');
  if (!root) throw new Error(`${options.path}: not a KiCad board: no kicad_pcb root`);
  const ids = new Identifiers(options.projectId);
  const tolerance = options.arcTolerance ?? 1000;
  const notes = new Set<string>();
  notes.add('the fabrication profile is not in the board file');

  // Layers: copper, top to bottom.
  const declared = (child(root, 'layers') ?? []).slice(1).filter(isList) as List[];
  const copper = declared
    .map((l) => ({ name: atom(l, 1) ?? '', type: atom(l, 2) ?? 'signal' }))
    .filter((l) => l.name.endsWith('.Cu'))
    .sort((a, b) => {
      const rank = (n: string) => (n === 'F.Cu' ? -1 : n === 'B.Cu' ? 1e6 : Number(/^In(\d+)\.Cu$/.exec(n)?.[1] ?? 1e5));
      return rank(a.name) - rank(b.name);
    });
  const layerId = new Map(copper.map((l) => [l.name, ids.id('LYR', l.name)]));
  const layers: LayerEntry[] = copper.map((l) => ({
    id: layerId.get(l.name)!,
    name: l.name,
    layer_kind: 'copper',
    ...(l.name === 'F.Cu' ? { side: 'front' as const } : l.name === 'B.Cu' ? { side: 'back' as const } : {}),
    function: l.type === 'power' ? 'plane' : l.type === 'mixed' ? 'mixed' : 'signal',
  }));
  const layerIds = (names: string[]) =>
    names.flatMap((n) => (n === '*.Cu' ? copper.map((c) => layerId.get(c.name)!) : layerId.has(n) ? [layerId.get(n)!] : []));

  // Nets: numbered declarations, or names written in place.
  const netNames = new Map<string, string>();
  for (const n of children(root, 'net')) {
    const a = atom(n, 1);
    const b = atom(n, 2);
    if (a !== undefined && b !== undefined) netNames.set(a, b);
  }
  const nets: LayoutInput['nets'] = {};
  const netId = (node: List | undefined): string | undefined => {
    const a = atom(node, 1);
    if (a === undefined) return undefined;
    const name = atom(node, 2) ?? netNames.get(a) ?? (/^\d+$/.test(a) ? undefined : a);
    if (!name) return undefined;
    const id = ids.id('NET', name);
    nets[id] = { name };
    return id;
  };

  // Footprints and components.
  const footprints: LayoutInput['footprints'] = {};
  const components: LayoutInput['components'] = {};
  for (const fp of children(root, 'footprint').concat(children(root, 'module'))) {
    const def = footprintDefinition(fp, notes);
    const hash = contentHash(def);
    footprints[hash] = def;
    const refdes = property(fp, 'Reference') ?? '?';
    const symbolPath = atom(child(fp, 'path'), 1);
    const uuid = atom(child(fp, 'uuid'), 1) ?? atom(child(fp, 'tstamp'), 1);
    const path = symbolPath ?? `refdes:${refdes}` + (uuid ? `@${uuid}` : '');
    const cid = ids.id('CMP', path);
    const at = child(fp, 'at');
    const pads: Component['pads'] = {};
    for (const p of children(fp, 'pad')) {
      const number = atom(p, 1) ?? '';
      if (!number) continue;
      const net = netId(child(p, 'net'));
      pads[number] = { pin: ids.id('PIN', `${path}.${number}`), ...(net && { net }) };
    }
    const sheet = property(fp, 'Sheetname');
    components[cid] = {
      refdes,
      ...(property(fp, 'Value') !== undefined && { value: property(fp, 'Value')! }),
      footprint: hash,
      pose: { x: nmOf(atom(at, 1)), y: nmOf(atom(at, 2)), rot: rotationOfDegrees(atom(at, 3)) },
      side: atom(child(fp, 'layer'), 1)?.startsWith('B.') ? 'back' : 'front',
      locked: fp.includes('locked') || atom(child(fp, 'locked'), 1) === 'yes',
      owner: 'import',
      pads,
      source_refs: {
        ...(uuid && { kicad_uuid: uuid }),
        ...(symbolPath && { symbol_path: symbolPath }),
        ...(sheet && { sheet }),
      },
    };
  }

  // Routed copper and zones.
  const identity = (prefix: string, kind: string, uuid: string | undefined, index: number) => {
    const path = `board.${kind}.${uuid ?? index}`;
    const id = ids.id(prefix, path);
    return { id, identity: { id, origin: 'imported' as const, path, ...(uuid && { external_id: uuid }) } };
  };
  const traces: LayoutInput['routing']['traces'] = {};
  [...children(root, 'segment'), ...children(root, 'arc')].forEach((s, i) => {
    const net = netId(child(s, 'net'));
    const layer = layerId.get(atom(child(s, 'layer'), 1) ?? '');
    if (!net || !layer) return;
    const { id, identity: ident } = identity('TRC', 'trace', atom(child(s, 'uuid'), 1), i);
    const trace: Trace = {
      kind: 'trace',
      id,
      identity: ident,
      net,
      layer,
      width: nmOf(atom(child(s, 'width'), 1)),
      start: xy(pt(child(s, 'start'))),
      ...(child(s, 'mid') && { mid: xy(pt(child(s, 'mid'))) }),
      end: xy(pt(child(s, 'end'))),
    } as Trace;
    traces[id] = trace;
  });
  const vias: LayoutInput['routing']['vias'] = {};
  children(root, 'via').forEach((v, i) => {
    const net = netId(child(v, 'net'));
    const pair = layerIds((child(v, 'layers') ?? []).slice(1).filter((x): x is string => typeof x === 'string'));
    if (!net || pair.length !== 2) return;
    const { id, identity: ident } = identity('VIA', 'via', atom(child(v, 'uuid'), 1), i);
    vias[id] = {
      kind: 'via',
      id,
      identity: ident,
      net,
      at: xy(pt(child(v, 'at'))),
      diameter: nmOf(atom(child(v, 'size'), 1)),
      drill: nmOf(atom(child(v, 'drill'), 1)),
      layers: [pair[0]!, pair[1]!],
    } as Via;
  });
  const zones: LayoutInput['routing']['zones'] = {};
  const zoneSpans = childSpans(source, source.indexOf('(kicad_pcb')).filter((s) => s.tag === 'zone');
  children(root, 'zone').forEach((z, i) => {
    if (child(z, 'keepout')) {
      notes.add('rule areas (keepouts) are not imported as regions');
      return;
    }
    const outline = ringOf(children(child(child(z, 'polygon') ?? [], 'pts') ?? [], 'xy').map(pt));
    const zoneLayers = layerIds(
      child(z, 'layers')
        ? (child(z, 'layers') ?? []).slice(1).filter((x): x is string => typeof x === 'string')
        : [atom(child(z, 'layer'), 1) ?? ''],
    );
    if (!outline || !zoneLayers.length) return;
    const span = zoneSpans[i];
    const net = atom(child(z, 'net_name'), 1) ? netId(['net', 'x', atom(child(z, 'net_name'), 1)!]) : netId(child(z, 'net'));
    const fill = child(z, 'fill');
    const { id, identity: ident } = identity('ZONE', 'zone', atom(child(z, 'uuid'), 1), i);
    const clearance = mmQuantity(atom(child(child(z, 'connect_pads') ?? [], 'clearance'), 1));
    const gap = mmQuantity(atom(child(fill ?? [], 'thermal_gap'), 1));
    const bridge = mmQuantity(atom(child(fill ?? [], 'thermal_bridge_width'), 1));
    zones[id] = {
      kind: 'zone',
      id,
      identity: ident,
      ...(net && { net }),
      layers: zoneLayers as [string, ...string[]],
      outline: outline as never,
      priority: Number(atom(child(z, 'priority'), 1) ?? '0'),
      ...(clearance && { clearance }),
      ...((gap || bridge) && { thermal: { ...(gap && { gap }), ...(bridge && { bridge }) } }),
      definition: span ? source.slice(span.start, span.end) : '',
    } as Zone;
  });

  // The board outline: the largest edge-cut ring, and the others as cutouts.
  const { rings, complete } = edgeRings(root, tolerance);
  if (!complete) notes.add('edge cuts that do not close into rings are not imported');
  rings.sort((a, b) => polygonArea(b) - polygonArea(a));
  const outline = rings[0] ? ringOf(rings[0]) : undefined;
  if (!outline) throw new Error(`${options.path}: no closed board outline on Edge.Cuts`);
  const cutouts = rings
    .slice(1)
    .map((r) => ringOf(r))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({ outline: r as never }));
  const thickness = atom(child(child(root, 'general') ?? [], 'thickness'), 1);

  return {
    schema_version: '2.0',
    parent: {
      imported: [{ path: options.path, hash: 'sha256:' + createHash('sha256').update(source, 'utf8').digest('hex') }],
    },
    config: contentHash({ ...ADAPTER, project: options.projectId, arc_tolerance: tolerance }),
    packs: [],
    board: {
      unit: 'nm',
      outline: outline as never,
      ...(cutouts.length && { cutouts }),
      ...(thickness && { thickness: mmQuantity(thickness)! }),
      arc_tolerance: tolerance,
      fabrication_profile: 'unspecified',
      layers: layers as never,
      lossy: [...notes].sort(),
    },
    footprints,
    components,
    nets,
    circuits: {},
    constraints: {},
    routing: { traces, vias, zones },
  } as LayoutInput;
}

/**
 * Specctra session (.ses) import (implementation spec §6.6). Freerouting
 * writes coordinates in resolution units (0.1 µm each for `(resolution um
 * 10)`, verified on a real 2.4.1 session), echoes the DSN's layer names, and
 * names vias by padstack. Y is negated back. An unknown layer is a named
 * failure, never a silent mapping.
 */
import { parseSexp, children, child, isList, type SexpNode } from '../../../../kicad/sexp.js';
import { uuidv5 } from '../../../../kicad/emit.js';
import type { TrackSegment, Via, DesignRules } from '../../../ir/types.js';
import { EngineError } from '../../../ir/status.js';

const atom = (n: SexpNode[] | undefined, i: number): string | undefined => (typeof n?.[i] === 'string' ? (n![i] as string) : undefined);
const UNIT_NM: Record<string, number> = { um: 1000, mm: 1_000_000, mil: 25_400, inch: 25_400_000, cm: 10_000_000 };

function* lists(node: SexpNode): Generator<SexpNode[]> {
  if (isList(node)) {
    yield node;
    for (const c of node) yield* lists(c);
  }
}

function find(root: SexpNode, head: string): SexpNode[] | undefined {
  for (const l of lists(root)) if (l[0] === head) return l;
  return undefined;
}

export interface SesResult {
  segments: TrackSegment[];
  vias: Via[];
  /** Nets the session routed (by name). */
  nets: string[];
  /** Wires narrower than `minWidthNm` that were widened to it (Freerouting's neck-down at small pads), by net name. */
  widened: { count: number; nets: string[] };
}

export function parseSes(text: string, ctx: { copperLayers: string[]; netIdByName: Map<string, string>; rules: DesignRules; namespace: string; minWidthNm?: number }): SesResult {
  const widened = { count: 0, nets: [] as string[] };
  const roots = parseSexp(text);
  const session = roots.find(isList);
  if (!session || session[0] !== 'session') throw new EngineError('malformed-output', 'session file has no (session …) root', 'Freerouting wrote something that is not a Specctra session');
  const routes = find(session, 'routes') ?? session;
  const res = find(routes, 'resolution');
  const unit = atom(res, 1) ?? 'um';
  const value = Number(atom(res, 2) ?? '1');
  const nmPerUnit = (UNIT_NM[unit] ?? 1000) / (Number.isFinite(value) && value > 0 ? value : 1);
  const toNm = (s: string | undefined, what: string): number => {
    const v = Number(s);
    if (!Number.isFinite(v)) throw new EngineError('malformed-output', `${what}: "${s}" is not a number`, 'the session is corrupt');
    return Math.round(v * nmPerUnit);
  };
  const viaStacks = new Map<string, { size: number; drill: number }>();
  const libOut = find(routes, 'library_out');
  for (const ps of libOut ? children(libOut, 'padstack') : []) {
    const name = atom(ps, 1) ?? '';
    const m = /_(\d+):(\d+)_um/.exec(name);
    let size = 0;
    for (const sh of children(ps, 'shape')) {
      const c = child(sh, 'circle');
      if (c) size = Math.max(size, toNm(atom(c, 2), 'via diameter'));
    }
    viaStacks.set(name, { size: size || (m ? Number(m[1]) * 1000 : ctx.rules.viaDiameterNm), drill: m ? Number(m[2]) * 1000 : ctx.rules.viaDrillNm });
  }
  const layerId = (name: string): string => {
    if (ctx.copperLayers.includes(name)) return name;
    throw new EngineError('malformed-output', `session references layer "${name}", which the board does not have (${ctx.copperLayers.join(', ')})`, 'the DSN and the session disagree on layer names');
  };
  const segments: TrackSegment[] = [];
  const vias: Via[] = [];
  const nets: string[] = [];
  const netOut = find(routes, 'network_out') ?? routes;
  for (const net of children(netOut, 'net')) {
    const name = atom(net, 1);
    if (name === undefined) continue;
    const netId = ctx.netIdByName.get(name);
    if (!netId) continue;
    nets.push(name);
    let k = 0;
    for (const wire of children(net, 'wire')) {
      const path = child(wire, 'path');
      if (!path) continue;
      const layer = layerId(atom(path, 1) ?? '');
      let width = toNm(atom(path, 2), 'wire width');
      if (ctx.minWidthNm && width < ctx.minWidthNm) {
        widened.count++;
        if (!widened.nets.includes(name)) widened.nets.push(name);
        width = ctx.minWidthNm;
      }
      const coords = path.slice(3).filter((x): x is string => typeof x === 'string');
      for (let i = 0; i + 3 < coords.length; i += 2) {
        const a = { x: toNm(coords[i], 'x'), y: -toNm(coords[i + 1], 'y') };
        const b = { x: toNm(coords[i + 2], 'x'), y: -toNm(coords[i + 3], 'y') };
        if (a.x === b.x && a.y === b.y) continue;
        segments.push({ id: uuidv5(`ses/${name}/seg/${k++}`, ctx.namespace), netId, layer, a, b, width });
      }
    }
    let v = 0;
    for (const via of children(net, 'via')) {
      const stack = viaStacks.get(atom(via, 1) ?? '') ?? { size: ctx.rules.viaDiameterNm, drill: ctx.rules.viaDrillNm };
      vias.push({ id: uuidv5(`ses/${name}/via/${v++}`, ctx.namespace), netId, at: { x: toNm(atom(via, 2), 'via x'), y: -toNm(atom(via, 3), 'via y') }, size: stack.size, drill: stack.drill, layers: [ctx.copperLayers[0]!, ctx.copperLayers[ctx.copperLayers.length - 1]!] });
    }
  }
  return { segments, vias, nets, widened };
}

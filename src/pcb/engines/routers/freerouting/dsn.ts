/**
 * Specctra DSN emission for router-freerouting (implementation spec §6.6).
 * Modelled on KiCad's own exporter, verified against pcbnew on a KiCad 10
 * board: `(resolution um 10)` with micrometre coordinates and Y negated;
 * `(place REF x y front rot)` with KiCad's rotation for front parts and
 * 180 + rot for back parts; one image per distinct footprint geometry with
 * pins in footprint-local coordinates; padstacks interned by geometry with the
 * pad's rotation relative to its footprint baked in (polygons for anything
 * that is not a circle); the outline inset by the copper-to-edge clearance as
 * the boundary; every net's REF-PAD pins; one default class with width,
 * clearance, and the via. Existing copper is emitted as protected wiring only
 * when the job preserves it.
 */
import type { PcbDesign, PadDefinition, ComponentInstance } from '../../../ir/types.js';
import { copperStack } from '../../../ir/layers.js';
import { rotate, rotatePoint, translate, offset, bbox, area, type Polygon, type Point } from '../../../ir/geometry.js';
import { mdegToDeg, normMdeg } from '../../../ir/units.js';

export interface DsnOptions {
  boardName: string;
  /** Route only these nets (others' pads stay as obstacles). */
  netIds?: Set<string> | null;
  preserveExistingRoutes?: boolean;
  /** Copper-to-edge inset for the boundary (nm). */
  edgeClearanceNm: number;
  /** Width for every routable net in scope, overriding the class width (staged power routing). */
  trackWidthNm?: number;
  /** Clearance the engine routes to, overriding the board's rule (the generous-first pass asks for more than the rule). */
  clearanceNm?: number;
  /** Per copper layer id: active flag and preferred direction (Freerouting `autoroute_settings`). */
  layers?: Record<string, { active?: boolean; preferredDirection?: 'horizontal' | 'vertical' }>;
}

const um = (nm: number): string => String(Math.round(nm / 1000));
const umY = (nm: number): string => String(-Math.round(nm / 1000));
const q = (s: string): string => `"${s.replace(/"/g, '')}"`;
/** Specctra tokens need quoting when they carry spaces or parens; KiCad quotes liberally. */
const tok = (s: string): string => (/^[A-Za-z0-9_.+\-:/#$]+$/.test(s) ? s : q(s));

interface Padstack {
  name: string;
  layers: string[];
  shape: { kind: 'circle'; d: number } | { kind: 'polygon'; pts: Point[] };
}

function polygonKey(pts: Point[]): string {
  return pts.map((p) => `${Math.round(p.x / 1000)},${Math.round(p.y / 1000)}`).join(';');
}

/**
 * The pad's copper in the footprint's local frame (rotation relative to the
 * footprint baked in). Images are presented from the top view, as KiCad's
 * exporter does: a back-side footprint is flipped about its X axis (local
 * y negated, layers swapped) and placed with `back` and rotation + 180,
 * which Specctra's own left-right mirror undoes.
 */
function localCopper(pad: PadDefinition, c: ComponentInstance): Polygon {
  const local = rotate(translate(pad.copper, -pad.at.x, -pad.at.y), -c.rotation);
  return c.attributes.side === 'back' ? mirrorY(local) : local;
}

function localPoint(p: Point, c: ComponentInstance): Point {
  const local = rotatePoint({ x: p.x - c.at.x, y: p.y - c.at.y }, -c.rotation);
  return c.attributes.side === 'back' ? { x: local.x, y: -local.y } : local;
}

function mirrorY(poly: Polygon): Polygon {
  const m = (pts: Point[]) => pts.map((p) => ({ x: p.x, y: -p.y })).reverse();
  return { outer: m(poly.outer), holes: poly.holes.map(m) };
}

/** Copper layers of a pad as seen from the top view (swapped for back-side footprints). */
function topViewLayers(pad: PadDefinition, c: ComponentInstance, copper: string[]): string[] {
  const layers = pad.layers.filter((l) => copper.includes(l));
  if (c.attributes.side !== 'back' || layers.length !== 1) return layers;
  const i = copper.indexOf(layers[0]!);
  return [copper[copper.length - 1 - i]!];
}

export function emitDsn(design: PcbDesign, opts: DsnOptions): string {
  const copper = copperStack(design);
  const rules = design.board.rules;
  const nets = new Map(design.nets.map((n) => [n.id, n]));
  const out: string[] = [];
  const padstacks = new Map<string, Padstack>();
  const stackOf = (pad: PadDefinition, c: ComponentInstance): string => {
    const local = localCopper(pad, c);
    const layers = topViewLayers(pad, c, copper);
    const tag = layers.length > 1 ? 'A' : layers[0] === copper[0] ? 'T' : 'B';
    let stack: Padstack;
    if (pad.shape === 'circle') {
      stack = { name: `Round[${tag}]Pad_${um(pad.size.w)}_um`, layers, shape: { kind: 'circle', d: pad.size.w } };
    } else {
      const pts = local.outer;
      const key = polygonKey(pts);
      const rot = normMdeg(c.attributes.side === 'back' ? -(pad.rotation - c.rotation) : pad.rotation - c.rotation);
      const b = bbox(local);
      stack = { name: `${pad.shape === 'roundrect' ? 'RoundRect' : pad.shape === 'oval' ? 'Oval' : 'Rect'}[${tag}]Pad_${um(b.maxX - b.minX)}x${um(b.maxY - b.minY)}_um_${Math.round(mdegToDeg(rot))}_${hash(key)}`, layers, shape: { kind: 'polygon', pts } };
    }
    if (!padstacks.has(stack.name)) padstacks.set(stack.name, stack);
    return stack.name;
  };
  // images: one per distinct (libId, pin geometry)
  interface Image { name: string; outline: Point[]; pins: { stack: string; number: string; at: Point }[] }
  const images = new Map<string, Image>();
  const imageOf = new Map<string, string>(); // component id -> image name
  const nameCount = new Map<string, number>();
  for (const c of design.components) {
    const pins = c.pads.filter((p) => p.layers.some((l) => copper.includes(l))).map((p) => ({ stack: stackOf(p, c), number: p.number, at: localPoint(p.at, c) }));
    const outlinePoly = c.footprint.courtyard ? rotate(translate(c.footprint.courtyard, -c.at.x, -c.at.y), -c.rotation) : null;
    const b = outlinePoly ? bbox(outlinePoly) : bbox({ outer: pins.length ? pins.map((p) => p.at) : [{ x: 0, y: 0 }], holes: [] });
    const outline = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
    const key = `${c.footprint.libId}|${pins.map((p) => `${p.number}@${p.stack}@${Math.round(p.at.x / 1000)},${Math.round(p.at.y / 1000)}`).join('|')}`;
    let name = [...images.values()].find((im) => im.pins.length === pins.length && imagesKey(im) === key)?.name;
    if (!name) {
      const n = nameCount.get(c.footprint.libId) ?? 0;
      nameCount.set(c.footprint.libId, n + 1);
      name = n === 0 ? c.footprint.libId : `${c.footprint.libId}::${n}`;
      images.set(name, { name, outline, pins });
      (images.get(name) as Image & { key?: string }).key = key;
    }
    imageOf.set(c.id, name);
  }
  function imagesKey(im: Image): string {
    return (im as Image & { key?: string }).key ?? '';
  }

  const viaName = `Via[0-1]_${um(rules.viaDiameterNm)}:${um(rules.viaDrillNm)}_um`;
  out.push(`(pcb ${q(opts.boardName)}`);
  out.push(`  (parser\n    (string_quote ")\n    (space_in_quoted_tokens on)\n    (host_cad "copperhead")\n    (host_version "pcb-layout-framework")\n  )`);
  out.push('  (resolution um 10)');
  out.push('  (unit um)');
  out.push('  (structure');
  copper.forEach((l, i) => out.push(`    (layer ${tok(l)}\n      (type signal)\n      (property\n        (index ${i})\n      )\n    )`));
  // boundary: outline inset by the edge clearance so a track hugging the boundary still clears the real edge
  const inset = opts.edgeClearanceNm > 0 ? offset(design.board.outline, -opts.edgeClearanceNm) : [design.board.outline];
  const boundary = inset.sort((a, b) => area(b) - area(a))[0] ?? design.board.outline;
  const bpts = [...boundary.outer, boundary.outer[0]!];
  out.push(`    (boundary\n      (path pcb 0 ${bpts.map((p) => `${um(p.x)} ${umY(p.y)}`).join('  ')})\n    )`);
  out.push(`    (via ${q(viaName)})`);
  const clearance = opts.clearanceNm ?? rules.clearanceNm;
  out.push(`    (rule\n      (width ${um(rules.trackWidthNm)})\n      (clearance ${um(clearance)})\n      (clearance ${um(Math.min(clearance, 50_000))} (type smd_smd))\n    )`);
  if (opts.layers && Object.keys(opts.layers).length) {
    // layer-preference constraints as Freerouting's own per-layer autoroute settings
    const rulesOut = copper.map((l) => {
      const pref = opts.layers![l] ?? {};
      const dir = pref.preferredDirection ?? (copper.indexOf(l) % 2 === 0 ? 'horizontal' : 'vertical');
      return `      (layer_rule ${tok(l)}\n        (active ${pref.active === false ? 'off' : 'on'})\n        (preferred_direction ${dir})\n        (preferred_direction_trace_costs 1.0)\n        (against_preferred_direction_trace_costs ${pref.preferredDirection ? '3.0' : '2.5'})\n      )`;
    });
    out.push(`    (autoroute_settings\n      (fanout off)\n      (autoroute on)\n      (postroute on)\n      (vias on)\n      (via_costs 50)\n      (plane_via_costs 5)\n      (start_ripup_costs 100)\n      (start_pass_no 1)\n${rulesOut.join('\n')}\n    )`);
  }
  out.push('  )');
  // placement
  out.push('  (placement');
  const byImage = new Map<string, ComponentInstance[]>();
  for (const c of design.components) {
    const im = imageOf.get(c.id)!;
    if (!byImage.has(im)) byImage.set(im, []);
    byImage.get(im)!.push(c);
  }
  for (const [im, comps] of byImage) {
    out.push(`    (component ${tok(im)}`);
    for (const c of comps) {
      const side = c.attributes.side;
      const rot = mdegToDeg(normMdeg(side === 'back' ? c.rotation + 180_000 : c.rotation));
      out.push(`      (place ${tok(c.reference)} ${um(c.at.x)} ${umY(c.at.y)} ${side} ${fmtDeg(rot)} (PN ${q(c.value || c.reference)}))`);
    }
    out.push('    )');
  }
  out.push('  )');
  // library
  out.push('  (library');
  for (const im of images.values()) {
    out.push(`    (image ${tok(im.name)}`);
    const o = [...im.outline, im.outline[0]!];
    out.push(`      (outline (path signal 0 ${o.map((p) => `${um(p.x)} ${umY(p.y)}`).join('  ')}))`);
    for (const p of im.pins) out.push(`      (pin ${tok(p.stack)} ${tok(p.number)} ${um(p.at.x)} ${umY(p.at.y)})`);
    out.push('    )');
  }
  for (const s of padstacks.values()) {
    out.push(`    (padstack ${tok(s.name)}`);
    for (const l of s.layers) {
      if (s.shape.kind === 'circle') out.push(`      (shape (circle ${tok(l)} ${um(s.shape.d)}))`);
      else out.push(`      (shape (polygon ${tok(l)} 0 ${s.shape.pts.map((p) => `${um(p.x)} ${umY(p.y)}`).join('  ')}))`);
    }
    out.push('      (attach off)');
    out.push('    )');
  }
  out.push(`    (padstack ${q(viaName)}`);
  for (const l of copper) out.push(`      (shape (circle ${tok(l)} ${um(rules.viaDiameterNm)}))`);
  out.push('      (attach off)');
  out.push('    )');
  out.push('  )');
  // network
  out.push('  (network');
  const refOfPad = new Map<string, string>();
  for (const c of design.components) for (const p of c.pads) refOfPad.set(p.id, `${c.reference}-${p.number}`);
  const routable = design.nets.filter((n) => n.padIds.length >= 2 && (!opts.netIds || opts.netIds.has(n.id)));
  for (const n of routable) {
    out.push(`    (net ${tok(n.name)}\n      (pins ${n.padIds.map((id) => refOfPad.get(id)).filter(Boolean).map((r) => tok(r!)).join(' ')})\n    )`);
  }
  out.push(`    (class kicad_default ${routable.map((n) => tok(n.name)).join(' ')}\n      (circuit\n        (use_via ${q(viaName)})\n      )\n      (rule\n        (width ${um(opts.trackWidthNm ?? rules.trackWidthNm)})\n        (clearance ${um(opts.clearanceNm ?? rules.clearanceNm)})\n      )\n    )`);
  out.push('  )');
  // wiring: protected existing copper
  out.push('  (wiring');
  if (opts.preserveExistingRoutes) {
    for (const s of design.routing.segments) {
      const n = nets.get(s.netId);
      if (!n) continue;
      out.push(`    (wire (path ${tok(s.layer)} ${um(s.width)}  ${um(s.a.x)} ${umY(s.a.y)}  ${um(s.b.x)} ${umY(s.b.y)})(net ${tok(n.name)})(type protect))`);
    }
    for (const v of design.routing.vias) {
      const n = nets.get(v.netId);
      if (!n) continue;
      out.push(`    (via ${q(viaName)} ${um(v.at.x)} ${umY(v.at.y)} (net ${tok(n.name)})(type protect))`);
    }
  }
  out.push('  )');
  out.push(')');
  return out.join('\n') + '\n';
}

function fmtDeg(d: number): string {
  return Number.isInteger(d) ? String(d) : d.toFixed(3).replace(/\.?0+$/, '');
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

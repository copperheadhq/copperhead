/**
 * Board population and emission (issue #252): turn a schematic netlist plus
 * resolved footprint geometry into a populated `.kicad_pcb` — the missing
 * "board half of `create`" the issue describes. Footprints carry their real pads
 * and net assignments; the emitter writes deterministic text (UUIDv5, canonical
 * order), never serializing through the s-expression reader.
 */

import { uuidv5, knum } from './emit.js';
import type { BoardModel, Net, Pad, PlacedFootprint, RoutedBoard } from './layout/types.js';
import type { Netlist } from './netlist.js';
import type { FootprintDef } from './fplib.js';

export const BOARD_VERSION = '20240108';
export const BOARD_GENERATOR = 'copperhead';

/** A footprint resolver: lib_id -> parsed pad geometry. */
export type FootprintResolver = (libId: string) => Promise<FootprintDef | null>;

/** A part whose footprint could not be resolved from the installed libraries. */
export interface UnresolvedFootprint {
  ref: string;
  footprint: string;
}

export interface BuildResult {
  board: BoardModel;
  unresolved: UnresolvedFootprint[];
}

/** Convert parsed footprint pads to board pads (footprint-local, net empty). */
function toPads(def: FootprintDef): Pad[] {
  return def.pads.map((p) => ({
    number: p.number,
    net: '',
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    layers: p.layers,
    type: p.type,
    shape: p.shape,
    rot: p.rot,
    ...(p.drill !== undefined ? { drill: p.drill } : {}),
    ...(p.drillOffset ? { drillOffset: p.drillOffset } : {}),
  }));
}

/**
 * Resolve every netlist component to a footprint and assign pad nets. Nets with
 * fewer than two nodes are KiCad's `unconnected-(…)` no-connect markers, so they
 * are dropped — those pads stay on net 0. Footprints whose library is missing are
 * reported in `unresolved` and skipped (the caller owns the rollback/refusal).
 */
export async function buildBoard(netlist: Netlist, resolve: FootprintResolver): Promise<BuildResult> {
  const footprints: PlacedFootprint[] = [];
  const unresolved: UnresolvedFootprint[] = [];

  for (const comp of netlist.components) {
    const def = await resolve(comp.footprint);
    if (!def) {
      unresolved.push({ ref: comp.ref, footprint: comp.footprint });
      continue;
    }
    footprints.push({
      ref: comp.ref,
      footprint: comp.footprint,
      value: comp.value,
      x: 0,
      y: 0,
      rotation: 0,
      side: 'front',
      pads: toPads(def),
      ...(def.courtyard ? { courtyard: def.courtyard } : {}),
    });
  }

  const padNet = new Map<string, string>();
  const nets: Net[] = [];
  for (const net of netlist.nets) {
    if (net.nodes.length < 2) continue;
    nets.push({ name: net.name, pins: net.nodes.map((n) => ({ ref: n.ref, pad: n.pin })) });
    for (const node of net.nodes) padNet.set(`${node.ref}/${node.pin}`, net.name);
  }

  for (const fp of footprints) {
    for (const pad of fp.pads) pad.net = padNet.get(`${fp.ref}/${pad.number}`) ?? '';
  }

  return { board: { width: 0, height: 0, footprints, nets }, unresolved };
}

const LAYERS: [number, string, string][] = [
  [0, 'F.Cu', 'signal'],
  [31, 'B.Cu', 'signal'],
  [32, 'B.Adhes', 'user'],
  [33, 'F.Adhes', 'user'],
  [34, 'B.Paste', 'user'],
  [35, 'F.Paste', 'user'],
  [36, 'B.SilkS', 'user'],
  [37, 'F.SilkS', 'user'],
  [38, 'B.Mask', 'user'],
  [39, 'F.Mask', 'user'],
  [40, 'Dwgs.User', 'user'],
  [41, 'Cmts.User', 'user'],
  [42, 'Eco1.User', 'user'],
  [43, 'Eco2.User', 'user'],
  [44, 'Edge.Cuts', 'user'],
  [45, 'Margin', 'user'],
  [46, 'B.CrtYd', 'user'],
  [47, 'F.CrtYd', 'user'],
  [48, 'B.Fab', 'user'],
  [49, 'F.Fab', 'user'],
];

const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Emit a populated `.kicad_pcb`. Footprints must already be placed (`x`/`y`/
 * `rotation` set) and `board.width`/`height` must bound them, since the emitter
 * writes the Edge.Cuts outline from those numbers.
 */
export function emitBoard(board: BoardModel, name: string): string {
  const netNumber = netNumbers(board);

  const out: string[] = [];
  const line = (d: number, s: string): void => {
    out.push(`${'\t'.repeat(d)}${s}`);
  };

  line(0, '(kicad_pcb');
  line(1, `(version ${BOARD_VERSION})`);
  line(1, `(generator ${q(BOARD_GENERATOR)})`);
  line(1, '(generator_version "0")');
  line(1, '(general');
  line(2, '(thickness 1.6)');
  line(1, ')');
  line(1, `(paper ${q('A4')})`);
  line(1, '(layers');
  for (const [num, lname, type] of LAYERS) line(2, `(${num} ${q(lname)} ${type})`);
  line(1, ')');
  line(1, '(setup');
  line(2, '(pad_to_mask_clearance 0)');
  line(1, ')');
  line(1, '(net 0 "")');
  for (const n of board.nets) line(1, `(net ${netNumber.get(n.name)} ${q(n.name)})`);

  for (const fp of board.footprints) {
    const layer = fp.side === 'back' ? 'B.Cu' : 'F.Cu';
    // Reference/value text sit just outside the courtyard so silk never clips copper.
    const ext = fp.courtyard ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const refY = ext.minY - 0.5;
    const valY = ext.maxY + 0.5;
    line(1, `(footprint ${q(fp.footprint)} (layer ${q(layer)}) (uuid ${q(uuidv5(`fp/${fp.ref}`))})`);
    line(2, `(at ${knum(fp.x)} ${knum(fp.y)} ${Math.round(fp.rotation)})`);
    line(
      2,
      `(property "Reference" ${q(fp.ref)} (at 0 ${knum(refY)} 0) (layer "F.SilkS") (uuid ${q(uuidv5(`fp/${fp.ref}/ref`))}) (effects (font (size 1 1) (thickness 0.15))))`,
    );
    line(
      2,
      `(property "Value" ${q(fp.value ?? fp.ref)} (at 0 ${knum(valY)} 0) (layer "F.Fab") (uuid ${q(uuidv5(`fp/${fp.ref}/value`))}) (effects (font (size 1 1) (thickness 0.15))))`,
    );
    for (const pad of fp.pads) {
      const n = pad.net ? (netNumber.get(pad.net) ?? 0) : 0;
      const type = pad.type ?? 'smd';
      const shape = pad.shape ?? 'rect';
      const rot = pad.rot ?? 0;
      const layers = pad.layers.length ? pad.layers.map(q).join(' ') : '"F.Cu"';
      const net = n > 0 ? ` (net ${n} ${q(pad.net)})` : '';
      const rr = shape === 'roundrect' ? ' (roundrect_rratio 0.25)' : '';
      const atRot = rot !== 0 ? ` ${Math.round(rot)}` : '';
      // Through-hole pads must carry their hole; an omitted drill is read as a
      // 0 mm hole and fails DRC (`drill_out_of_range`, `padstack_invalid`).
      const drill =
        pad.drill !== undefined
          ? pad.drillOffset
            ? ` (drill ${knum(pad.drill)} (offset ${knum(pad.drillOffset.x)} ${knum(pad.drillOffset.y)}))`
            : ` (drill ${knum(pad.drill)})`
          : '';
      line(
        2,
        `(pad ${q(pad.number)} ${type} ${shape} (at ${knum(pad.x)} ${knum(pad.y)}${atRot}) (size ${knum(pad.width)} ${knum(pad.height)})${drill} (layers ${layers})${rr}${net} (uuid ${q(uuidv5(`fp/${fp.ref}/pad/${pad.number}`))}))`,
      );
    }
    line(1, ')');
  }

  line(1, `(gr_rect (start 0 0) (end ${knum(board.width)} ${knum(board.height)})`);
  line(2, '(stroke (width 0.1) (type default))');
  line(2, '(layer "Edge.Cuts")');
  line(2, `(uuid ${q(uuidv5(`edge/${name}`))})`);
  line(1, ')');

  line(0, ')');
  return `${out.join('\n')}\n`;
}

/** Net name → board net number (net 0 is the empty net). */
export function netNumbers(board: BoardModel): Map<string, number> {
  const m = new Map<string, number>();
  board.nets.forEach((n, i) => m.set(n.name, i + 1));
  return m;
}

/**
 * Emit a populated, routed board: the placed footprints plus the routed tracks
 * and vias as `(segment …)`/`(via …)` records. Track coordinates are already in
 * mm (the SES parser converts back through `dsnToMm`), matching the emitter.
 */
export function emitRoutedBoard(board: BoardModel, name: string, routed: RoutedBoard): string {
  const netNum = netNumbers(board);
  const routeLines: string[] = [];
  // Segments are keyed on the track index AND the segment index: the segment
  // index alone is per-track, so two wires on the same net would collide.
  routed.tracks.forEach((t, trackIndex) => {
    const n = netNum.get(t.net) ?? 0;
    for (let i = 0; i + 1 < t.points.length; i++) {
      const a = t.points[i]!;
      const b = t.points[i + 1]!;
      routeLines.push(
        `\t(segment (start ${knum(a.x)} ${knum(a.y)}) (end ${knum(b.x)} ${knum(b.y)}) (width ${knum(t.width)}) (layer ${q(t.layer)}) (net ${n}) (uuid ${q(uuidv5(`route/${t.net}/${trackIndex}/${i}`))}))`,
      );
    }
  });
  routed.vias.forEach((v, viaIndex) => {
    const n = netNum.get(v.net) ?? 0;
    routeLines.push(
      `\t(via (at ${knum(v.x)} ${knum(v.y)}) (size ${knum(v.diameter)}) (drill ${knum(v.drill)}) (layers "F.Cu" "B.Cu") (net ${n}) (uuid ${q(uuidv5(`via/${v.net}/${viaIndex}`))}))`,
    );
  });
  if (!routeLines.length) return emitBoard(board, name);
  const text = emitBoard(board, name);
  return text.replace(/\n\)\s*$/, `\n${routeLines.join('\n')}\n)`);
}


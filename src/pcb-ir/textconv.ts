import { readFile } from 'node:fs/promises';
import { child, children, isList, parseSexp, type SexpNode } from '../kicad/sexp.js';
import { compareRefdes } from './diff.js';
import { degrees, distanceNm, mm, rotationOf } from './geometry.js';

/**
 * The board text of RFC 11 Section 14.4: a KiCad board printed one fact per
 * line, fields in a fixed order, so that a version control system's diff of
 * two revisions shows each changed fact as one changed line.
 *
 *   board outline (x, y) to (x, y) layers F.Cu B.Cu
 *   footprint R1 1k Resistor_SMD:R_0603_1608Metric (20, 7) 0 front locked
 *   net GND layers B.Cu F.Cu segments 3 length 12.5 vias 2
 *   zone GND B.Cu priority 0 vertices 4
 *
 * Positions are millimetres and angles degrees, written exactly. The reader
 * makes no CAD-tool, model, or network call. Enable it for git with
 * `*.kicad_pcb diff=copperhead-pcb` in .gitattributes and
 * `git config diff.copperhead-pcb.textconv "copperhead pcb textconv"`.
 */

type List = SexpNode[];

function atom(node: List | undefined, index: number): string | undefined {
  const v = node?.[index];
  return typeof v === 'string' ? v : undefined;
}

/** A KiCad decimal in millimetres as integer nanometres, without binary rounding. */
export function nmOf(text: string | undefined): number {
  if (text === undefined) return 0;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return Math.round(Number(text) * 1_000_000);
  const [, sign, whole = '', frac = ''] = m;
  const value = Number(whole || '0') * 1_000_000 + Number((frac + '000000').slice(0, 6));
  return sign === '-' ? -value : value;
}

function point(node: List | undefined): [number, number] {
  return [nmOf(atom(node, 1)), nmOf(atom(node, 2))];
}

function at(p: [number, number]): string {
  return `(${mm(p[0])}, ${mm(p[1])})`;
}

function angle(text: string | undefined): string {
  return degrees(rotationOf(Math.round(Number(text ?? '0') * 1000)));
}

function arcLength(start: [number, number], mid: [number, number], end: [number, number]): number {
  const [ax, ay] = start;
  const [bx, by] = mid;
  const [cx, cy] = end;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (d === 0) return distanceNm(ax, ay, cx, cy);
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const a1 = Math.atan2(by - uy, bx - ux);
  const a2 = Math.atan2(cy - uy, cx - ux);
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const sweepCcw = norm(a2 - a0);
  const throughMid = norm(a1 - a0) <= sweepCcw;
  return r * (throughMid ? sweepCcw : 2 * Math.PI - sweepCcw);
}

function reference(fp: List): string {
  for (const p of children(fp, 'property')) if (atom(p, 1) === 'Reference') return atom(p, 2) ?? '?';
  for (const t of children(fp, 'fp_text')) if (atom(t, 1) === 'reference') return atom(t, 2) ?? '?';
  return '?';
}

function fpValue(fp: List): string {
  for (const p of children(fp, 'property')) if (atom(p, 1) === 'Value') return atom(p, 2) ?? '';
  for (const t of children(fp, 'fp_text')) if (atom(t, 1) === 'value') return atom(t, 2) ?? '';
  return '';
}

function isLocked(fp: List): boolean {
  return fp.includes('locked') || atom(child(fp, 'locked'), 1) === 'yes';
}

function field(text: string): string {
  return text === '' ? '-' : /\s/.test(text) ? JSON.stringify(text) : text;
}

export function boardText(source: string): string {
  const root = parseSexp(source).find((n): n is List => isList(n) && n[0] === 'kicad_pcb');
  if (!root) throw new Error('not a KiCad board: no kicad_pcb root');

  const netNames = new Map<string, string>();
  for (const n of children(root, 'net')) {
    const id = atom(n, 1);
    const name = atom(n, 2);
    if (id !== undefined && name !== undefined) netNames.set(id, name);
  }
  const netOf = (node: List): string => {
    const n = child(node, 'net');
    const a = atom(n, 1);
    if (a === undefined) return '';
    return atom(n, 2) ?? netNames.get(a) ?? a;
  };

  const layerNames: string[] = [];
  const layers = child(root, 'layers');
  if (layers) {
    for (const l of layers.slice(1)) {
      if (isList(l) && typeof l[1] === 'string' && l[1].endsWith('.Cu')) layerNames.push(l[1]);
    }
  }

  // The outline: the extent of every Edge.Cuts drawing.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const node of root) {
    if (!isList(node) || typeof node[0] !== 'string' || !node[0].startsWith('gr_')) continue;
    if (atom(child(node, 'layer'), 1) !== 'Edge.Cuts') continue;
    for (const key of ['start', 'end', 'mid', 'center']) {
      const p = child(node, key);
      if (p) {
        const [x, y] = point(p);
        xs.push(x);
        ys.push(y);
      }
    }
    for (const xy of children(child(node, 'pts') ?? [], 'xy')) {
      const [x, y] = point(xy);
      xs.push(x);
      ys.push(y);
    }
  }
  const outline = xs.length
    ? `outline ${at([Math.min(...xs), Math.min(...ys)])} to ${at([Math.max(...xs), Math.max(...ys)])}`
    : 'outline none';
  const lines: string[] = [`board ${outline} layers ${layerNames.join(' ') || '-'}`];

  const footprints = children(root, 'footprint')
    .concat(children(root, 'module'))
    .map((fp) => {
      const pos = child(fp, 'at');
      const side = atom(child(fp, 'layer'), 1)?.startsWith('B.') ? 'back' : 'front';
      const ref = reference(fp);
      const text = [
        'footprint',
        field(ref),
        field(fpValue(fp)),
        field(atom(fp, 1) ?? '-'),
        at(point(pos)),
        angle(atom(pos, 3)),
        side,
        ...(isLocked(fp) ? ['locked'] : []),
      ].join(' ');
      return { ref, text };
    });
  footprints.sort((a, b) => compareRefdes(a.ref, b.ref) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  lines.push(...footprints.map((f) => f.text));

  // Routed copper per net.
  const nets = new Map<string, { layers: Set<string>; segments: number; length: number; vias: number }>();
  const entry = (name: string) => {
    let e = nets.get(name);
    if (!e) nets.set(name, (e = { layers: new Set(), segments: 0, length: 0, vias: 0 }));
    return e;
  };
  for (const seg of children(root, 'segment')) {
    const e = entry(netOf(seg));
    const [x1, y1] = point(child(seg, 'start'));
    const [x2, y2] = point(child(seg, 'end'));
    e.segments++;
    e.length += distanceNm(x1, y1, x2, y2);
    const layer = atom(child(seg, 'layer'), 1);
    if (layer) e.layers.add(layer);
  }
  for (const arc of children(root, 'arc')) {
    const e = entry(netOf(arc));
    e.segments++;
    e.length += Math.round(arcLength(point(child(arc, 'start')), point(child(arc, 'mid')), point(child(arc, 'end'))));
    const layer = atom(child(arc, 'layer'), 1);
    if (layer) e.layers.add(layer);
  }
  for (const via of children(root, 'via')) entry(netOf(via)).vias++;
  const netLines = [...nets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([name, e]) =>
        `net ${field(name)} layers ${[...e.layers].sort().join(' ') || '-'} segments ${e.segments} length ${mm(
          e.length,
        )} vias ${e.vias}`,
    );
  lines.push(...netLines);

  // Zones.
  const zones = children(root, 'zone').map((z) => {
    const net = atom(child(z, 'net_name'), 1) ?? netOf(z);
    const layer = atom(child(z, 'layer'), 1) ?? (child(z, 'layers') ?? []).slice(1).filter((x) => typeof x === 'string').join(',');
    const priority = atom(child(z, 'priority'), 1) ?? '0';
    const vertices = children(child(child(z, 'polygon') ?? [], 'pts') ?? [], 'xy').length;
    return `zone ${field(net)} ${layer || '-'} priority ${priority} vertices ${vertices}`;
  });
  zones.sort();
  lines.push(...zones);

  return lines.join('\n') + '\n';
}

export async function boardTextOfFile(file: string): Promise<string> {
  return boardText(await readFile(file, 'utf8'));
}

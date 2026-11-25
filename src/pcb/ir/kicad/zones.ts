/**
 * Zone refill and fill extraction (RFC 11 §6.6, implementation spec §4.5).
 * Refill goes through `kicad-cli pcb drc --refill-zones --save-board`, so one
 * process both regenerates the fills on disk and produces the DRC report the
 * KiCad DRC checker consumes.
 */
import { readFile } from 'node:fs/promises';
import { runDrc } from '../../../kicad/cli.js';
import type { CheckReport } from '../../../kicad/report.js';
import { parseSexp, children, child, isList, type SexpNode } from '../../../kicad/sexp.js';
import { mmToNm } from '../units.js';
import type { Point, ZoneFill } from '../types.js';
import { topLevelBlocks } from './blocks.js';

/** Refill zones in place and return KiCad's DRC report for the refilled board. */
export async function refillZones(pcbPath: string, opts: { schematicParity?: boolean } = {}): Promise<CheckReport> {
  return runDrc(pcbPath, { refillZones: true, saveBoard: true, ...(opts.schematicParity ? { schematicParity: true } : {}) });
}

const atom = (n: SexpNode[] | undefined, i: number): string | undefined => (typeof n?.[i] === 'string' ? (n![i] as string) : undefined);

/** Read every zone's `filled_polygon` blocks from board text. */
export function extractFills(boardText: string): ZoneFill[] {
  const out: ZoneFill[] = [];
  for (const b of topLevelBlocks(boardText)) {
    if (b.head !== 'zone') continue;
    const z = parseSexp(b.text)[0];
    if (!z || !isList(z)) continue;
    const zoneId = atom(child(z, 'uuid'), 1) ?? atom(child(z, 'tstamp'), 1) ?? '';
    for (const fp of children(z, 'filled_polygon')) {
      const layer = atom(child(fp, 'layer'), 1) ?? '';
      const pts = child(fp, 'pts');
      const outer: Point[] = [];
      for (const xy of pts ? children(pts, 'xy') : []) {
        const x = Number(atom(xy, 1));
        const y = Number(atom(xy, 2));
        if (Number.isFinite(x) && Number.isFinite(y)) outer.push({ x: mmToNm(x), y: mmToNm(y) });
      }
      if (outer.length < 3) continue;
      const existing = out.find((f) => f.zoneId === zoneId && f.layer === layer);
      if (existing) existing.polygons.push({ outer, holes: [] });
      else out.push({ zoneId, layer, polygons: [{ outer, holes: [] }] });
    }
  }
  return out;
}

export async function readFills(pcbPath: string): Promise<ZoneFill[]> {
  return extractFills(await readFile(pcbPath, 'utf8'));
}

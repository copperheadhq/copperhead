import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FIXTURE } from './helpers.js';
import { normalizeReport } from '../src/kicad/report.js';
import { parseBom } from '../src/kicad/bom-export.js';
import { listSymbols, parseSexp, children, child } from '../src/kicad/sexp.js';
import { boardFootprints } from '../src/kicad/populate.js';
import { checkDocumentationPresence } from '../src/kicad/fab.js';

const ZOO = path.join(path.dirname(FIXTURE), 'fab-zoo');
const GOOD_SCH = path.join(FIXTURE, 'hardware', 'open-key.kicad_sch');
const GOOD_PCB = path.join(FIXTURE, 'hardware', 'open-key.kicad_pcb');
const BASE_PCB = path.join(ZOO, '_base', 'hardware', 'open-key.kicad_pcb');

interface SegmentGeom {
  net: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function segmentsIntersect(a: SegmentGeom, b: SegmentGeom): boolean {
  const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number) =>
    (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  const onSeg = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    qx <= Math.max(px, rx) + 1e-9 &&
    qx >= Math.min(px, rx) - 1e-9 &&
    qy <= Math.max(py, ry) + 1e-9 &&
    qy >= Math.min(py, ry) - 1e-9;

  const d1 = cross(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const d2 = cross(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const d3 = cross(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const d4 = cross(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (Math.abs(d1) < 1e-9 && onSeg(a.x1, a.y1, b.x1, b.y1, a.x2, a.y2)) return true;
  if (Math.abs(d2) < 1e-9 && onSeg(a.x1, a.y1, b.x2, b.y2, a.x2, a.y2)) return true;
  if (Math.abs(d3) < 1e-9 && onSeg(b.x1, b.y1, a.x1, a.y1, b.x2, b.y2)) return true;
  if (Math.abs(d4) < 1e-9 && onSeg(b.x1, b.y1, a.x2, a.y2, b.x2, b.y2)) return true;
  return false;
}

describe('fab release gate broken-fixture zoo (#14)', () => {
  it('0. _base: preserves the full 20-layer table, routes all 4 nets without crossings, and has 0 DRC errors/unconnected', async () => {
    const goodRoot = parseSexp(await readFile(GOOD_PCB, 'utf8'))[0]!;
    const baseText = await readFile(BASE_PCB, 'utf8');
    const baseRoot = parseSexp(baseText)[0]!;
    expect(child(baseRoot, 'layers')).toEqual(child(goodRoot, 'layers'));
    expect(boardFootprints(baseText).map((f) => f.ref)).toEqual(['R1', 'R2', 'U1']);

    const segs: SegmentGeom[] = children(baseRoot, 'segment').map((seg) => {
      const start = child(seg, 'start')!;
      const end = child(seg, 'end')!;
      const net = String(child(seg, 'net')![1]);
      return {
        net,
        x1: Number(start[1]),
        y1: Number(start[2]),
        x2: Number(end[1]),
        y2: Number(end[2]),
      };
    });
    expect([...new Set(segs.map((s) => s.net))].sort()).toEqual(['1', '2', '3', '4']);
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[i]!.net !== segs[j]!.net) {
          expect(segmentsIntersect(segs[i]!, segs[j]!)).toBe(false);
        }
      }
    }

    const baseDrc = JSON.parse(await readFile(path.join(ZOO, '_base', 'drc-base.json'), 'utf8'));
    const errors = (baseDrc.violations as Array<{ severity?: string }>).filter((v) => v.severity === 'error');
    expect(errors).toEqual([]);
    expect(baseDrc.unconnected_items).toEqual([]);
  });

  it('1. unrouted-net: deletes only KEY_DAH (net 4) segments from _base while keeping 3V3, EN, and GND routed', async () => {
    const pcbText = await readFile(path.join(ZOO, 'unrouted-net', 'hardware', 'open-key.kicad_pcb'), 'utf8');
    const root = parseSexp(pcbText)[0]!;
    expect(boardFootprints(pcbText).map((f) => f.ref)).toEqual(['R1', 'R2', 'U1']);
    const routedNets = new Set(
      children(root, 'segment').map((seg) => child(seg, 'net')?.[1]),
    );
    expect([...routedNets].sort()).toEqual(['1', '2', '3']);
    const rawDrc = JSON.parse(await readFile(path.join(ZOO, 'unrouted-net', 'drc-unrouted-net.json'), 'utf8'));
    const errors = (rawDrc.violations as Array<{ severity?: string }>).filter((v) => v.severity === 'error');
    expect(errors).toEqual([]);
    const report = normalizeReport(rawDrc, 'drc');
    expect(report.unrouted).toBe(1);
    expect(rawDrc.unconnected_items[0].items[0].description).toContain('KEY_DAH');
  });

  it('2. mpn-less-bom: R2 lacks an MPN while R1 and U1 are complete', async () => {
    const rows = parseBom(await readFile(path.join(ZOO, 'mpn-less-bom', 'docs', 'BOM.md'), 'utf8'));
    expect(rows.map((r) => r.refdes)).toEqual(['R1', 'R2', 'U1']);
    expect(rows.find((r) => r.refdes === 'R1')?.hasMpn).toBe(true);
    expect(rows.find((r) => r.refdes === 'R2')?.hasMpn).toBe(false);
    expect(rows.find((r) => r.refdes === 'U1')?.hasMpn).toBe(true);
  });

  it('3. unverified-bom: all rows have MPNs and footprints, with U1 flagged UNVERIFIED', async () => {
    const rows = parseBom(await readFile(path.join(ZOO, 'unverified-bom', 'docs', 'BOM.md'), 'utf8'));
    expect(rows.every((r) => r.hasMpn && r.footprint.length > 0)).toBe(true);
    expect(rows.filter((r) => r.unverified).map((r) => r.refdes)).toEqual(['U1']);
  });

  it('4. refdes-mismatch: R2 is present in the schematic but absent from the board', async () => {
    const syms = await listSymbols(GOOD_SCH);
    const fps = boardFootprints(await readFile(path.join(ZOO, 'refdes-mismatch', 'hardware', 'open-key.kicad_pcb'), 'utf8'));
    expect(syms.map((s) => s.ref)).toEqual(['R1', 'R2', 'U1']);
    expect(fps.map((f) => f.ref)).toEqual(['R1', 'U1']);
  });

  it('5. footprint-mismatch: R2 has R_0805_2012Metric on the board vs R_0603_1608Metric in the schematic', async () => {
    const syms = await listSymbols(GOOD_SCH);
    const fps = boardFootprints(await readFile(path.join(ZOO, 'footprint-mismatch', 'hardware', 'open-key.kicad_pcb'), 'utf8'));
    const schR2 = syms.find((s) => s.ref === 'R2')!;
    const pcbR2 = fps.find((f) => f.ref === 'R2')!;
    expect(schR2.footprint).toBe('Resistor_SMD:R_0603_1608Metric');
    expect(pcbR2.footprint).toBe('Resistor_SMD:R_0805_2012Metric');
  });

  it('6. missing-draft-quality: docs/LAYOUT.md omits ## Draft quality and fails checkDocumentationPresence', async () => {
    const layoutMd = await readFile(path.join(ZOO, 'missing-draft-quality', 'docs', 'LAYOUT.md'), 'utf8');
    const res = checkDocumentationPresence({ layoutMd, devplanExists: true, isCreateRepo: false });
    expect(res.status).toBe('fail');
    expect(res.violations).toEqual([
      {
        claim: 'release-ready',
        actual: 'missing ## Draft quality section',
        location: 'docs/LAYOUT.md',
      },
    ]);
  });
});

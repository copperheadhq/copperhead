import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FIXTURE } from './helpers.js';
import { normalizeReport } from '../src/kicad/report.js';
import { parseBom } from '../src/kicad/bom-export.js';
import { listSymbols } from '../src/kicad/sexp.js';
import { boardFootprints } from '../src/kicad/populate.js';
import { checkDocumentationPresence } from '../src/kicad/fab.js';

const ZOO = path.join(path.dirname(FIXTURE), 'fab-zoo');
const GOOD_SCH = path.join(FIXTURE, 'hardware', 'open-key.kicad_sch');

describe('fab release gate broken-fixture zoo (#14)', () => {
  it('1. unrouted-net: board leaves KEY_DAH unrouted and DRC report records 1 unconnected item', async () => {
    const pcbText = await readFile(path.join(ZOO, 'unrouted-net', 'open-key.kicad_pcb'), 'utf8');
    expect(boardFootprints(pcbText).map((f) => f.ref)).toEqual(['R1', 'R2', 'U1']);
    const rawDrc = JSON.parse(await readFile(path.join(ZOO, 'unrouted-net', 'drc-unrouted-net.json'), 'utf8'));
    const report = normalizeReport(rawDrc, 'drc');
    expect(report.unrouted).toBe(1);
    expect(rawDrc.unconnected_items[0].items[0].description).toContain('KEY_DAH');
  });

  it('2. mpn-less-bom: R2 lacks an MPN while R1 and U1 are complete', async () => {
    const rows = parseBom(await readFile(path.join(ZOO, 'mpn-less-bom', 'BOM.md'), 'utf8'));
    expect(rows.map((r) => r.refdes)).toEqual(['R1', 'R2', 'U1']);
    expect(rows.find((r) => r.refdes === 'R1')?.hasMpn).toBe(true);
    expect(rows.find((r) => r.refdes === 'R2')?.hasMpn).toBe(false);
    expect(rows.find((r) => r.refdes === 'U1')?.hasMpn).toBe(true);
  });

  it('3. unverified-bom: all rows have MPNs and footprints, with U1 flagged UNVERIFIED', async () => {
    const rows = parseBom(await readFile(path.join(ZOO, 'unverified-bom', 'BOM.md'), 'utf8'));
    expect(rows.every((r) => r.hasMpn && r.footprint.length > 0)).toBe(true);
    expect(rows.filter((r) => r.unverified).map((r) => r.refdes)).toEqual(['U1']);
  });

  it('4. refdes-mismatch: R2 is present in the schematic but absent from the board', async () => {
    const syms = await listSymbols(GOOD_SCH);
    const fps = boardFootprints(await readFile(path.join(ZOO, 'refdes-mismatch', 'open-key.kicad_pcb'), 'utf8'));
    expect(syms.map((s) => s.ref)).toEqual(['R1', 'R2', 'U1']);
    expect(fps.map((f) => f.ref)).toEqual(['R1', 'U1']);
  });

  it('5. footprint-mismatch: R2 has R_0805_2012Metric on the board vs R_0603_1608Metric in the schematic', async () => {
    const syms = await listSymbols(GOOD_SCH);
    const fps = boardFootprints(await readFile(path.join(ZOO, 'footprint-mismatch', 'open-key.kicad_pcb'), 'utf8'));
    const schR2 = syms.find((s) => s.ref === 'R2')!;
    const pcbR2 = fps.find((f) => f.ref === 'R2')!;
    expect(schR2.footprint).toBe('Resistor_SMD:R_0603_1608Metric');
    expect(pcbR2.footprint).toBe('Resistor_SMD:R_0805_2012Metric');
  });

  it('6. missing-draft-quality: LAYOUT.md omits ## Draft quality and fails checkDocumentationPresence', async () => {
    const layoutMd = await readFile(path.join(ZOO, 'missing-draft-quality', 'LAYOUT.md'), 'utf8');
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

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { duplicateFootprintRefs, normalizeReport, formatViolations } from '../src/kicad/report.js';
import { REPORTS } from './helpers.js';

const load = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(REPORTS, name), 'utf8'));

describe('report normalizer', () => {
  it('normalizes a clean ERC report', async () => {
    const r = normalizeReport(await load('erc-clean.json'), 'erc');
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('normalizes a clean DRC report', async () => {
    const r = normalizeReport(await load('drc-clean.json'), 'drc');
    expect(r.ok).toBe(true);
  });

  it('carries type, severity, and location for violations (AC-2.2 source)', async () => {
    const r = normalizeReport(await load('erc-unconnected-pin.json'), 'erc');
    expect(r.ok).toBe(false);
    const pin = r.violations.find((v) => v.type === 'pin_not_connected');
    expect(pin).toBeDefined();
    expect(pin!.severity).toBe('error');
    expect(pin!.sheet).toBe('/');
    expect(pin!.items[0]!.x).toBeTypeOf('number');
  });

  it('tolerates unknown shapes', () => {
    expect(normalizeReport({}, 'erc').ok).toBe(true);
    expect(normalizeReport({ violations: [{}] }, 'drc').violations).toHaveLength(1);
  });
});

describe('unrouted connections (#314)', () => {
  it('are counted, not violations: a draft board with ratsnest is DRC clean', () => {
    const r = normalizeReport(
      {
        violations: [],
        schematic_parity: [],
        unconnected_items: [
          { type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [] },
          { type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [] },
        ],
      },
      'drc',
    );
    expect(r.ok).toBe(true);
    expect(r.unrouted).toBe(2);
    expect(r.violations).toEqual([]);
    expect(formatViolations(r)).toBe('DRC: clean (2 connection(s) unrouted, left as ratsnest)');
  });

  it('a real violation still fails beside unrouted ones', () => {
    const r = normalizeReport(
      {
        violations: [{ type: 'clearance', severity: 'error', description: 'Clearance violation', items: [] }],
        unconnected_items: [{ type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [] }],
      },
      'drc',
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.type)).toEqual(['clearance']);
    expect(r.unrouted).toBe(1);
  });
});

describe('findings inside one library footprint (#314)', () => {
  const v = (type: string, ...items: string[]) => ({ type, severity: 'error', description: type, items: items.map((description) => ({ description })) });

  it('are reported, not violations, when every item belongs to the same footprint', () => {
    const r = normalizeReport({ violations: [v('hole_clearance', 'Pad A1 [GND] of J1 on F.Cu', 'NPTH pad of J1')] }, 'drc');
    expect(r.ok).toBe(true);
    expect(r.intrinsic?.map((x) => x.type)).toEqual(['hole_clearance']);
    expect(formatViolations(r)).toContain('1 finding(s) inside a single library footprint, not a placement problem: J1 hole_clearance');
  });

  it('still fail when they span two parts or involve copper outside a footprint', () => {
    const between = normalizeReport({ violations: [v('clearance', 'Pad 1 [VBUS] of J1 on F.Cu', 'Pad 2 [GND] of R1 on F.Cu')] }, 'drc');
    expect(between.ok).toBe(false);
    const track = normalizeReport({ violations: [v('clearance', 'Pad 1 [VBUS] of J1 on F.Cu', 'Track [GND] on F.Cu, length 2.1 mm')] }, 'drc');
    expect(track.ok).toBe(false);
    expect(track.intrinsic).toEqual([]);
  });

  it('never excuse a short inside one footprint: two nets meeting is an electrical fault', () => {
    // two schematic nets wired onto coincident pads of one stock connector
    const short = normalizeReport({ violations: [v('shorting_items', 'Pad A4 [VCC] of J1 on F.Cu', 'Pad B9 [GND] of J1 on F.Cu')] }, 'drc');
    expect(short.ok).toBe(false);
    expect(short.violations.map((x) => x.type)).toEqual(['shorting_items']);
    expect(short.intrinsic).toEqual([]);
  });

  it("excuse a clearance between a footprint's own pads even across nets: that is the library's geometry", () => {
    // a stock USB-C receptacle's DP and DM pads sit closer than the board rule
    const clearance = normalizeReport({ violations: [v('clearance', 'Pad B6 [DP] of J1 on F.Cu', 'Pad B7 [DM] of J1 on F.Cu')] }, 'drc');
    expect(clearance.ok).toBe(true);
    expect(clearance.intrinsic?.map((x) => x.type)).toEqual(['clearance']);
  });

  it('never excuse two footprints that share a reference', () => {
    // two pasted mounting holes left unannotated, and a mis-annotated board
    const holes = normalizeReport({ violations: [v('hole_to_hole', 'NPTH pad of REF**', 'NPTH pad of REF**')] }, 'drc');
    expect(holes.ok).toBe(false);
    expect(holes.intrinsic).toEqual([]);
    const unannotated = normalizeReport({ violations: [v('clearance', 'Pad 1 [VBUS] of R? on F.Cu', 'Pad 2 [GND] of R? on F.Cu')] }, 'drc');
    expect(unannotated.ok).toBe(false);
    const twice = normalizeReport(
      { violations: [v('hole_clearance', 'Pad 1 [GND] of H1 on F.Cu', 'NPTH pad of H1')] },
      'drc',
      { duplicateRefs: new Set(['H1']) },
    );
    expect(twice.ok).toBe(false);
    expect(twice.violations.map((x) => x.type)).toEqual(['hole_clearance']);
  });

  it('excuses nothing when the board could not be read for its references', () => {
    const r = normalizeReport({ violations: [v('hole_clearance', 'Pad A1 [GND] of J1 on F.Cu', 'NPTH pad of J1')] }, 'drc', { excuse: false });
    expect(r.ok).toBe(false);
    expect(r.intrinsic).toEqual([]);
  });

  it('reads a reference carried by more than one footprint, in either KiCad syntax', () => {
    const board = [
      '(footprint "MountingHole:MountingHole_3.2mm_M3" (property "Reference" "H1" (at 0 0))',
      '(footprint "MountingHole:MountingHole_3.2mm_M3" (property "Reference" "H1" (at 5 0))',
      '(footprint "Resistor_SMD:R_0603_1608Metric" (property "Reference" "R1" (at 9 0))',
      '(module Old (fp_text reference U2 (at 0 0)) (fp_text reference "U2" (at 1 0)))',
    ].join('\n');
    expect([...duplicateFootprintRefs(board)].sort()).toEqual(['H1', 'U2']);
  });

  it('never excuse a footprint KiCad cannot check against its library', () => {
    // no library found (lib_footprint_issues) is as unvouched as a modified one
    const r = normalizeReport(
      {
        violations: [
          v('lib_footprint_issues', 'Footprint J1'),
          v('hole_clearance', 'Pad A1 [GND] of J1 on F.Cu', 'NPTH pad of J1'),
        ],
      },
      'drc',
    );
    expect(r.ok).toBe(false);
    expect(r.intrinsic).toEqual([]);
    expect(r.violations.map((x) => x.type)).toEqual(['lib_footprint_issues', 'hole_clearance']);
  });
});

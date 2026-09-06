import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitDsn, parseSes, mmToMil, milToMm, MILS_PER_MM } from '../src/kicad/layout/dsn.js';
import { parseSexp } from '../src/kicad/sexp.js';
import type { BoardModel, DesignRules } from '../src/kicad/layout/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'layout');

const board: BoardModel = {
  width: 25.4,
  height: 15.24,
  footprints: [
    {
      ref: 'U1',
      footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm',
      x: 5,
      y: 5,
      rotation: 0,
      side: 'front',
      courtyard: { width: 5, height: 4 },
      pads: [
        { number: '1', net: 'KEY_DAH', x: 4, y: 3, width: 0.6, height: 1.5, layers: ['F.Cu'] },
        { number: '2', net: 'GND', x: 4, y: 5, width: 0.6, height: 1.5, layers: ['F.Cu'] },
      ],
    },
    {
      ref: 'R1',
      footprint: 'Resistor_SMD:R_0603_1608Metric',
      x: 10,
      y: 10,
      rotation: 90,
      side: 'front',
      pads: [
        { number: '1', net: 'KEY_DAH', x: 9, y: 10, width: 0.8, height: 0.8, layers: ['F.Cu'] },
        { number: '2', net: 'VCC', x: 11, y: 10, width: 0.8, height: 0.8, layers: ['F.Cu'] },
      ],
    },
  ],
  nets: [
    { name: 'KEY_DAH', pins: [{ ref: 'U1', pad: '1' }, { ref: 'R1', pad: '1' }] },
    { name: 'GND', pins: [{ ref: 'U1', pad: '2' }] },
    { name: 'VCC', pins: [{ ref: 'R1', pad: '2' }] },
  ],
};

const rules: DesignRules = { clearance: 0.2, trackWidth: 0.25, viaDiameter: 0.6, viaDrill: 0.3 };

describe('Specctra DSN/SES bridge', () => {
  it('pins mm<->mil at the standard conversion point', () => {
    expect(mmToMil(25.4)).toBe(1000);
    expect(milToMm(1000)).toBeCloseTo(25.4, 9);
    expect(mmToMil(1)).toBe(Math.round(MILS_PER_MM));
  });

  it('emits a deterministic, well-formed DSN', () => {
    const a = emitDsn(board, rules, { boardName: 'open-key' });
    const b = emitDsn(board, rules, { boardName: 'open-key' });
    expect(a).toBe(b);

    // Well-formed s-expressions: parseSexp must return a single top-level list.
    const tree = parseSexp(a);
    expect(tree).toHaveLength(1);
    expect(Array.isArray(tree[0])).toBe(true);
    expect((tree[0] as unknown[])[0]).toBe('pcb');
  });

  it('carries the sections a router needs (structure/placement/library/network)', () => {
    const dsn = emitDsn(board, rules, { boardName: 'open-key' });
    expect(dsn).toContain('(unit mil)');
    expect(dsn).toContain('(resolution mil 100)');
    expect(dsn).toContain('(component U1');
    expect(dsn).toContain('(component R1');
    expect(dsn).toContain('(place front 197 197 0 none)'); // 5mm -> 197 mil
    expect(dsn).toContain('net "KEY_DAH"');
    expect(dsn).toContain('(pins U1-1 R1-1)');
    expect(dsn).toContain('(wiring');
  });

  it('parses a Freerouting-style SES back into tracks and vias', async () => {
    const ses = await readFile(path.join(FIXTURES, 'sample.ses'), 'utf8');
    const routed = parseSes(ses);

    expect(routed.vias).toHaveLength(1);
    expect(routed.vias[0]!.net).toBe('KEY_DAH');
    expect(routed.vias[0]!.x).toBeCloseTo(milToMm(1500), 9);
    expect(routed.vias[0]!.y).toBeCloseTo(milToMm(900), 9);
    expect(routed.vias[0]!.diameter).toBeCloseTo(milToMm(60), 9);
    expect(routed.vias[0]!.drill).toBeCloseTo(milToMm(30), 9);

    expect(routed.tracks).toHaveLength(3);
    const keyDah = routed.tracks.filter((t) => t.net === 'KEY_DAH');
    expect(keyDah).toHaveLength(2);
    expect(keyDah[0]!.points[0]).toEqual({ x: milToMm(1000), y: milToMm(500) });
    expect(keyDah[0]!.width).toBeCloseTo(milToMm(10), 9);
    expect(routed.tracks.find((t) => t.net === 'GND')!.points).toHaveLength(2);
  });

  it('tolerates an empty or non-session file', () => {
    expect(parseSes('(not-a-session)')).toEqual({ tracks: [], vias: [] });
    expect(parseSes('')).toEqual({ tracks: [], vias: [] });
  });
});

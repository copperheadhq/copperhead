import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emitDsn,
  parseSes,
  SesParseError,
  mmToDsn,
  dsnToMm,
  DSN_UNIT,
  viaPadstackName,
} from '../src/kicad/layout/dsn.js';
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
      courtyard: { minX: -2.5, minY: -2, maxX: 2.5, maxY: 2 },
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
  it('pins the um coordinate scale (KiCad parity, not mil)', () => {
    expect(mmToDsn(1)).toBe(1000);
    expect(dsnToMm(1000)).toBeCloseTo(1, 9);
    expect(mmToDsn(25.4)).toBe(25400);
  });

  it('emits a deterministic, well-formed DSN with KiCad-style units', () => {
    const a = emitDsn(board, rules, { boardName: 'open-key' });
    const b = emitDsn(board, rules, { boardName: 'open-key' });
    expect(a).toBe(b);

    const tree = parseSexp(a);
    expect(tree).toHaveLength(1);
    expect(Array.isArray(tree[0])).toBe(true);
    expect((tree[0] as unknown[])[0]).toBe('pcb');

    expect(a).toContain(`(resolution ${DSN_UNIT} 10)`);
    expect(a).toContain(`(unit ${DSN_UNIT})`);
    expect(a).toContain('(space_in_quoted_tokens on)');
    expect(a).toContain('(host_cad "copperhead")');
  });

  it('emits place records refdes-first with Y flipped into DSN space', () => {
    const dsn = emitDsn(board, rules, { boardName: 'open-key' });
    // U1 at (5,5)mm, front, 0° → 5000 -5000 front 0
    expect(dsn).toContain('(place U1 5000 -5000 front 0)');
    // R1 at (10,10)mm, 90° → 10000 -10000 front 90
    expect(dsn).toContain('(place R1 10000 -10000 front 90)');
  });

  it('references named padstacks instead of inlining pad geometry', () => {
    const dsn = emitDsn(board, rules, { boardName: 'open-key' });
    // U1's pads are 0.6×1.5mm rects on F.Cu only.
    expect(dsn).toContain('(padstack "Rect[T]Pad_600x1500_um"');
    expect(dsn).toContain('(shape (rect F.Cu -300 -750 300 750))');
    // A pin references the padstack by name; no inline shape on the pin line.
    expect(dsn).toContain('(pin "Rect[T]Pad_600x1500_um" "1" 4000 -3000)');
  });

  it('declares a via padstack named after its geometry and a net class', () => {
    const dsn = emitDsn(board, rules, { boardName: 'open-key' });
    const via = viaPadstackName(rules);
    expect(via).toBe('Via[0-1]_600:300_um');
    expect(dsn).toContain(`(via "${via}")`);
    expect(dsn).toContain('(circuit (use_via "Via[0-1]_600:300_um"))');
    // The class lists every net so the router has rules to apply to them (the
    // block closes after the (circuit …) and (rule …) child scopes).
    expect(dsn).toContain('(class kicad_default "KEY_DAH" "GND" "VCC"');
  });

  it('parses a Freerouting-shaped session into tracks and vias, preserving layer', async () => {
    const ses = await readFile(path.join(FIXTURES, 'sample.ses'), 'utf8');
    const routed = parseSes(ses, { rules });

    // One via, recovered from the library_out padstack geometry.
    expect(routed.vias).toHaveLength(1);
    expect(routed.vias[0]!.net).toBe('KEY_DAH');
    expect(routed.vias[0]!.x).toBeCloseTo(12, 9);
    expect(routed.vias[0]!.y).toBeCloseTo(8, 9);
    expect(routed.vias[0]!.diameter).toBeCloseTo(0.6, 9);
    expect(routed.vias[0]!.drill).toBeCloseTo(0.3, 9);

    // Three wires: two on KEY_DAH (F.Cu and B.Cu), one on GND.
    expect(routed.tracks).toHaveLength(3);
    const keyDah = routed.tracks.filter((t) => t.net === 'KEY_DAH');
    expect(keyDah).toHaveLength(2);
    // Layer is read from the path and preserved — collapsing to F.Cu would
    // turn this two-layer route into shorts.
    expect(keyDah.map((t) => t.layer).sort()).toEqual(['B.Cu', 'F.Cu']);
    const front = keyDah.find((t) => t.layer === 'F.Cu')!;
    expect(front.points[0]).toEqual({ x: 9, y: 8 });
    expect(front.points[1]).toEqual({ x: 12, y: 8 });
    expect(front.width).toBeCloseTo(0.25, 9);

    const gnd = routed.tracks.find((t) => t.net === 'GND')!;
    expect(gnd.points[1]).toEqual({ x: 2, y: 12 });
    expect(gnd.width).toBeCloseTo(0.4, 9);
  });

  it('rejects a non-session file and empty input', () => {
    expect(() => parseSes('(not-a-session)')).toThrow(SesParseError);
    expect(() => parseSes('')).toThrow(SesParseError);
  });
});

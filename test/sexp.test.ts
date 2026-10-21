import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { listSymbols, listFootprints, footprintsOf, listNets, pinNets, parseSexp } from '../src/kicad/sexp.js';
import { FIXTURE, tempFixtureRepo } from './helpers.js';

const SCH = path.join(FIXTURE, 'hardware', 'open-key.kicad_sch');
const PCB = path.join(FIXTURE, 'hardware', 'open-key-populated.kicad_pcb');
const BLANK_PCB = path.join(FIXTURE, 'hardware', 'open-key.kicad_pcb');

describe('sexp parser', () => {
  it('parses quoted strings with escapes', () => {
    const [node] = parseSexp('(a "b \\"c\\"" d)');
    expect(node).toEqual(['a', 'b "c"', 'd']);
  });

  it('lists real symbols with refdes, value, footprint (AC-1.2 source)', async () => {
    const syms = await listSymbols(SCH);
    expect(syms.map((s) => s.ref)).toEqual(['R1', 'R2', 'U1']);
    const r1 = syms.find((s) => s.ref === 'R1')!;
    expect(r1.value).toBe('10k');
    expect(r1.footprint).toBe('Resistor_SMD:R_0603_1608Metric');
    const u1 = syms.find((s) => s.ref === 'U1')!;
    expect(u1.value).toBe('ESP32-S3-MINI');
  });


  it('lists board footprints from the fixture board with refdes, footprint id, position, and side (#8)', async () => {
    expect(await listFootprints(BLANK_PCB)).toEqual([]);
    const fps = await listFootprints(PCB);
    const syms = await listSymbols(SCH);
    expect(fps.map((f) => f.ref)).toEqual(['R1', 'R2', 'U1']);
    expect(fps.map((f) => ({ ref: f.ref, footprint: f.footprint }))).toEqual(
      syms.map((s) => ({ ref: s.ref, footprint: s.footprint })),
    );
    const r2 = fps.find((f) => f.ref === 'R2')!;
    expect(r2.value).toBe('1k');
    expect(r2.layer).toBe('F.Cu');
    expect(r2.side).toBe('front');
    expect(r2.at).toEqual({ x: 116, y: 110, rot: 90 });
  });

  it('gracefully handles footprints without a Reference property and back-side / legacy fp_text footprints (#8)', () => {
    const boardText = `(kicad_pcb
      (version 20240108)
      (footprint "MountingHole:MountingHole_3.2mm_M3"
        (layer "F.Cu")
        (at 10 20)
      )
      (footprint "Capacitor_SMD:C_0402_1005Metric"
        (layer "B.Cu")
        (at 30 40 180)
        (fp_text reference "C10" (at 0 0) (layer "B.SilkS"))
        (fp_text value "100n" (at 0 0) (layer "B.Fab"))
      )
      (footprint "Resistor_SMD:R_0402_1005Metric"
        (layer "F.Cu")
        (at 15 25)
        (property "Reference" "R2" (at 0 0 0))
      )
    )`;
    const fps = footprintsOf(boardText);
    expect(fps.map((f) => f.ref)).toEqual(['?', 'C10', 'R2']);
    const missingRef = fps.find((f) => f.ref === '?')!;
    expect(missingRef.footprint).toBe('MountingHole:MountingHole_3.2mm_M3');
    expect(missingRef.side).toBe('front');
    expect(missingRef.at).toEqual({ x: 10, y: 20, rot: 0 });
    const backFp = fps.find((f) => f.ref === 'C10')!;
    expect(backFp.side).toBe('back');
    expect(backFp.layer).toBe('B.Cu');
    expect(backFp.value).toBe('100n');
    expect(backFp.at).toEqual({ x: 30, y: 40, rot: 180 });
  });

  it('lists nets from labels', async () => {
    const nets = await listNets(SCH);
    expect(nets).toEqual(['3V3', 'EN', 'GND', 'KEY_DAH']);
  });

  it('maps pins to nets geometrically (AC-1.3 source)', async () => {
    const pins = await pinNets(SCH);
    const u1 = new Map(pins.filter((p) => p.ref === 'U1').map((p) => [p.pinName, p.net]));
    expect(u1.get('GPIO14')).toBe('KEY_DAH');
    expect(u1.get('3V3')).toBe('3V3');
    expect(u1.get('GND')).toBe('GND');
    expect(u1.get('EN')).toBe('EN');
    expect(u1.get('GPIO0')).toBeNull();
    const r2 = new Map(pins.filter((p) => p.ref === 'R2').map((p) => [p.pinNumber, p.net]));
    expect(r2.get('1')).toBe('KEY_DAH');
    expect(r2.get('2')).toBe('GND');
  });

  it('supports custom power symbol libraries dynamically', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const customSch = path.join(repo, 'custom.kicad_sch');
      const content = `(kicad_sch
        (version 20231120)
        (uuid "0a0a0a0a-0000-4000-8000-000000000001")
        (lib_symbols
          (symbol "CustomPower:GND" (power)
            (pin power_in line (at 0 0 0) (length 0) hide
              (name "GND" (effects (font (size 1.27 1.27))))
              (number "1" (effects (font (size 1.27 1.27))))
            )
          )
          (symbol "Device:R"
            (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
            (property "Value" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
            (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
            (pin passive line (at 0 3.81 270) (length 1.27)
              (name "~" (effects (font (size 1.27 1.27))))
              (number "1" (effects (font (size 1.27 1.27))))
            )
            (pin passive line (at 0 -3.81 90) (length 1.27)
              (name "~" (effects (font (size 1.27 1.27))))
              (number "2" (effects (font (size 1.27 1.27))))
            )
          )
        )
        (symbol
          (lib_id "CustomPower:GND")
          (at 10 6.19 0)
          (uuid "0d0d0d0d-0000-4000-8000-000000000001")
          (property "Reference" "#PWR1" (at 10 6.19 0) (effects (font (size 1.27 1.27)) hide))
          (property "Value" "GND" (at 10 6.19 0) (effects (font (size 1.27 1.27))))
          (property "Footprint" "" (at 10 6.19 0) (effects (font (size 1.27 1.27)) hide))
          (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000001"))
        )
        (symbol
          (lib_id "Device:R")
          (at 10 10 0)
          (uuid "0d0d0d0d-0000-4000-8000-000000000002")
          (property "Reference" "R1" (at 10 10 0) (effects (font (size 1.27 1.27))))
          (property "Value" "10k" (at 10 10 0) (effects (font (size 1.27 1.27))))
          (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 10 10 0) (effects (font (size 1.27 1.27)) hide))
          (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000002"))
          (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000003"))
        )
        (wire
          (pts
            (xy 10 6.19)
            (xy 10 10)
          )
        )
      )`;

      const { writeFile } = await import('node:fs/promises');
      await writeFile(customSch, content, 'utf8');

      // 1. listSymbols: should EXCLUDE CustomPower:GND (only return R1)
      const syms = await listSymbols(customSch);
      expect(syms.map((s) => s.ref)).toEqual(['R1']);

      // 2. listNets: should INCLUDE "GND"
      const nets = await listNets(customSch);
      expect(nets).toContain('GND');

      // 3. pinNets: R1 pin 1 connected to GND should have net "GND"
      const pins = await pinNets(customSch);
      const r1Pins = pins.filter((p) => p.ref === 'R1');
      expect(r1Pins.find((p) => p.pinNumber === '1')?.net).toBe('GND');
    } finally {
      await cleanup();
    }
  });

  it('treats legacy power: prefix symbols as power symbols (not real components)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const legacySch = path.join(repo, 'legacy.kicad_sch');
      const content = `(kicad_sch
        (version 20231120)
        (uuid "1a1a1a1a-0000-4000-8000-000000000001")
        (lib_symbols
          (symbol "power:GND"
            (pin power_in line (at 0 0 0) (length 0) hide
              (name "GND" (effects (font (size 1.27 1.27))))
              (number "1" (effects (font (size 1.27 1.27))))
            )
          )
          (symbol "Device:C"
            (property "Reference" "C" (at 0 0 0) (effects (font (size 1.27 1.27))))
            (property "Value" "100n" (at 0 0 0) (effects (font (size 1.27 1.27))))
            (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
            (pin passive line (at 0 3.81 270) (length 1.27)
              (name "~" (effects (font (size 1.27 1.27))))
              (number "1" (effects (font (size 1.27 1.27))))
            )
          )
        )
        (symbol
          (lib_id "power:GND")
          (at 10 5 0)
          (uuid "1d1d1d1d-0000-4000-8000-000000000001")
          (property "Reference" "#PWR1" (at 10 5 0) (effects (font (size 1.27 1.27)) hide))
          (property "Value" "GND" (at 10 5 0) (effects (font (size 1.27 1.27))))
          (pin "1" (uuid "1e1e1e1e-0000-4000-8000-000000000001"))
        )
        (symbol
          (lib_id "Device:C")
          (at 10 10 0)
          (uuid "1d1d1d1d-0000-4000-8000-000000000002")
          (property "Reference" "C1" (at 10 10 0) (effects (font (size 1.27 1.27))))
          (property "Value" "100n" (at 10 10 0) (effects (font (size 1.27 1.27))))
          (property "Footprint" "Capacitor_SMD:C_0402_1005Metric" (at 10 10 0) (effects (font (size 1.27 1.27)) hide))
          (pin "1" (uuid "1e1e1e1e-0000-4000-8000-000000000002"))
        )
      )`;

      const { writeFile } = await import('node:fs/promises');
      await writeFile(legacySch, content, 'utf8');

      // power:GND must be excluded; only Device:C (C1) is a real component
      const syms = await listSymbols(legacySch);
      expect(syms.map((s) => s.ref)).toEqual(['C1']);
    } finally {
      await cleanup();
    }
  });
});

describe('quoted-string escapes', () => {
  it('maps \\n and \\t to real newline and tab, not the literal letters', () => {
    // KiCad writes multi-line text items as `line1\nline2`; reading that as
    // `line1nline2` gives the legibility width model wrong content and length.
    const [node] = parseSexp('(text "line1\\nline2\\tend")');
    expect((node as unknown[])[1]).toBe('line1\nline2\tend');
  });

  it('keeps escaped quotes and backslashes as the literal character', () => {
    const [node] = parseSexp('(a "q\\"b" "s\\\\t")');
    expect((node as unknown[])[1]).toBe('q"b');
    expect((node as unknown[])[2]).toBe('s\\t');
  });
});

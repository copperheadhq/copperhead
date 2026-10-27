import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { listSymbols, listNets, pinNets, parseSexp, listBoardFootprints } from '../src/kicad/sexp.js';
import { FIXTURE, tempFixtureRepo } from './helpers.js';

const SCH = path.join(FIXTURE, 'hardware', 'open-key.kicad_sch');

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

      const syms = await listSymbols(customSch);
      expect(syms.map((s) => s.ref)).toEqual(['R1']);

      const nets = await listNets(customSch);
      expect(nets).toContain('GND');

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

      const syms = await listSymbols(legacySch);
      expect(syms.map((s) => s.ref)).toEqual(['C1']);
    } finally {
      await cleanup();
    }
  });

  it('lists board footprints accurately from a kicad_pcb structure', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copperhead-test-'));
    const pcbFilePath = path.join(tmpDir, 'test.kicad_pcb');

    const samplePcbContent = `
      (kicad_pcb (version 20240101) (generator "copperhead")
        (footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" (at 120 60 90) (layer "F.Cu")
          (property "Reference" "U1" (at 0 0 0))
          (property "Value" "NE5532" (at 0 0 0))
        )
        (footprint "Resistor_SMD:R_0603_1608Metric" (at 110 50 0) (layer "F.Cu")
          (property "Reference" "R1" (at 0 0 0))
          (property "Value" "10k" (at 0 0 0))
        )
        (footprint "Legacy:C_0402" (at 100.5 50.5) (layer "B.Cu")
          (fp_text reference "C99" (at 0 0) (layer "B.SilkS"))
          (fp_text value "100nF" (at 0 0) (layer "B.Fab"))
        )
      )
    `;

    await fs.writeFile(pcbFilePath, samplePcbContent, 'utf8');

    const footprints = await listBoardFootprints(pcbFilePath);

    expect(footprints.length).toBe(3);
    expect(footprints.map((f) => f.ref)).toEqual(['C99', 'R1', 'U1']);

    const c99 = footprints.find((f) => f.ref === 'C99');
    expect(c99).toBeDefined();
    expect(c99?.value).toBe('100nF');
    expect(c99?.layer).toBe('B.Cu');
    expect(c99?.at).toEqual({ x: 100.5, y: 50.5, rot: 0 });
    expect(c99?.footprintId).toBe('Legacy:C_0402');

    const r1 = footprints.find((f) => f.ref === 'R1');
    expect(r1).toBeDefined();
    expect(r1?.value).toBe('10k');
    expect(r1?.at).toEqual({ x: 110, y: 50, rot: 0 });
    expect(r1?.footprintId).toBe('Resistor_SMD:R_0603_1608Metric');

    const u1 = footprints.find((f) => f.ref === 'U1');
    expect(u1).toBeDefined();
    expect(u1?.value).toBe('NE5532');
    expect(u1?.at).toEqual({ x: 120, y: 60, rot: 90 });
    expect(u1?.layer).toBe('F.Cu');
    expect(u1?.footprintId).toBe('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws a descriptive error when file is not a valid kicad_pcb file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copperhead-test-'));
    const invalidPcbPath = path.join(tmpDir, 'invalid.kicad_pcb');

    await fs.writeFile(invalidPcbPath, '(not_a_kicad_pcb_file)', 'utf8');

    await expect(listBoardFootprints(invalidPcbPath)).rejects.toThrow('not a KiCad PCB file');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handles default fallbacks for missing properties and nodes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copperhead-test-'));
    const minimalPcbPath = path.join(tmpDir, 'minimal.kicad_pcb');

    const minimalContent = `
      (kicad_pcb (version 20240101)
        (footprint)
      )
    `;

    await fs.writeFile(minimalPcbPath, minimalContent, 'utf8');

    const footprints = await listBoardFootprints(minimalPcbPath);
    expect(footprints.length).toBe(1);

    const fp = footprints[0]!;
    expect(fp.ref).toBe('?');
    expect(fp.value).toBe('');
    expect(fp.footprintId).toBe('');
    expect(fp.at).toEqual({ x: 0, y: 0, rot: 0 });
    expect(fp.layer).toBe('F.Cu');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('falls back to legacy fp_text value independently when only the modern Reference property is present', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copperhead-test-'));
    const mixedPcbPath = path.join(tmpDir, 'mixed.kicad_pcb');

    const mixedContent = `
      (kicad_pcb (version 20240101)
        (footprint "Regulator:SOT-23" (at 30 40 0) (layer "F.Cu")
          (property "Reference" "U5")
          (fp_text value "5V_REG")
        )
      )
    `;

    await fs.writeFile(mixedPcbPath, mixedContent, 'utf8');

    const footprints = await listBoardFootprints(mixedPcbPath);
    expect(footprints.length).toBe(1);

    const fp = footprints[0]!;
    expect(fp.ref).toBe('U5');
    expect(fp.value).toBe('5V_REG');

    await fs.rm(tmpDir, { recursive: true, force: true });
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

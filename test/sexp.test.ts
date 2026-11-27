import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { listSymbols, listNets, pinNets, parseSexp, instanceForPath, readSheetGeometry } from '../src/kicad/sexp.js';
import { checkLegibility } from '../src/kicad/legibility.js';
import { scoreFromGeometry } from '../src/kicad/score.js';
import { checkDrift } from '../src/memory/drift.js';
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

  it('loads reused hierarchical sheets per placement and resolves per-instance references (#394)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const rootSch = path.join(repo, 'root.kicad_sch');
      const chanSch = path.join(repo, 'chan.kicad_sch');
      const docsDir = path.join(repo, 'docs');
      await mkdir(docsDir, { recursive: true });

      const rootContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-000000000001")
        (lib_symbols)
        (sheet
          (at 20 20)
          (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000a1")
          (property "Sheetname" "ChanA" (at 20 19 0))
          (property "Sheetfile" "chan.kicad_sch" (at 20 41 0))
        )
        (sheet
          (at 60 20)
          (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000b1")
          (property "Sheetname" "ChanB" (at 60 19 0))
          (property "Sheetfile" "chan.kicad_sch" (at 60 41 0))
        )
      )`;

      const chanContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000c1")
        (lib_symbols
          (symbol "Device:R"
            (property "Reference" "R" (at 0 0 0))
            (property "Value" "R" (at 0 0 0))
            (property "Footprint" "" (at 0 0 0))
            (symbol "R_1_1"
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
        )
        (label "SIG" (at 10 6.19 0))
        (label "GND" (at 10 13.81 0))
        (symbol
          (lib_id "Device:R")
          (at 10 10 0)
          (uuid "00000000-0000-4000-8000-0000000000d1")
          (property "Reference" "R101" (at 10 10 0))
          (property "Value" "10k" (at 10 10 0))
          (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 10 10 0))
          (pin "1" (uuid "00000000-0000-4000-8000-0000000000e1"))
          (pin "2" (uuid "00000000-0000-4000-8000-0000000000e2"))
          (instances
            (project "p"
              (path "/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1"
                (reference "R101")
                (unit 1)
              )
              (path "/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000b1"
                (reference "R201")
                (unit 1)
              )
            )
          )
        )
      )`;

      await writeFile(rootSch, rootContent, 'utf8');
      await writeFile(chanSch, chanContent, 'utf8');

      const syms = await listSymbols(rootSch);
      expect(syms.map((s) => ({ ref: s.ref, sheet: s.sheet, unit: s.unit }))).toEqual([
        { ref: 'R101', sheet: 'ChanA', unit: 1 },
        { ref: 'R201', sheet: 'ChanB', unit: 1 },
      ]);

      const pins = await pinNets(rootSch);
      expect(pins).toEqual([
        { ref: 'R101', pinNumber: '1', pinName: '~', net: 'SIG' },
        { ref: 'R101', pinNumber: '2', pinName: '~', net: 'GND' },
        { ref: 'R201', pinNumber: '1', pinName: '~', net: 'SIG' },
        { ref: 'R201', pinNumber: '2', pinName: '~', net: 'GND' },
      ]);

      await writeFile(
        path.join(docsDir, 'BOM.md'),
        [
          '# BOM',
          '',
          '| Refdes | Value | Footprint | MPN | Subsystem |',
          '| --- | --- | --- | --- | --- |',
          '| R101 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | ChanA |',
          '| R201 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | ChanB |',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(docsDir, 'PINOUT.md'),
        [
          '# Pinout',
          '',
          '| Refdes | Pin | Name | Net | Notes |',
          '| --- | --- | --- | --- | --- |',
          '| R101 | 1 | ~ | SIG | |',
          '| R101 | 2 | ~ | GND | |',
          '| R201 | 1 | ~ | SIG | |',
          '| R201 | 2 | ~ | GND | |',
          '',
        ].join('\n'),
        'utf8',
      );

      const drift = await checkDrift(repo, 'docs', 'root.kicad_sch');
      expect(drift).toEqual([]);
    } finally {
      await cleanup();
    }
  });
  it('distinguishes nested reused sheet placements by hierarchical path (#394)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { writeFile } = await import('node:fs/promises');
      const rootSch = path.join(repo, 'root.kicad_sch');
      const chanSch = path.join(repo, 'channel.kicad_sch');
      const leafSch = path.join(repo, 'leaf.kicad_sch');

      const rootContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-000000000001")
        (lib_symbols)
        (sheet
          (at 20 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000a1")
          (property "Sheetname" "ChanA" (at 20 19 0))
          (property "Sheetfile" "channel.kicad_sch" (at 20 41 0))
        )
        (sheet
          (at 60 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000b1")
          (property "Sheetname" "ChanB" (at 60 19 0))
          (property "Sheetfile" "channel.kicad_sch" (at 60 41 0))
        )
      )`;

      const chanContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000c1")
        (lib_symbols)
        (sheet
          (at 20 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000d1")
          (property "Sheetname" "Filter" (at 20 19 0))
          (property "Sheetfile" "leaf.kicad_sch" (at 20 41 0))
        )
      )`;

      const leafContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000e1")
        (lib_symbols
          (symbol "Device:R"
            (property "Reference" "R" (at 0 0 0))
            (property "Value" "R" (at 0 0 0))
            (symbol "R_1_1"
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
        )
        (symbol
          (lib_id "Device:R")
          (at 10 10 0)
          (uuid "00000000-0000-4000-8000-0000000000f1")
          (property "Reference" "R101" (at 10 10 0))
          (property "Value" "10k" (at 10 10 0))
          (instances
            (project "root"
              (path "/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000d1"
                (reference "R101")
                (unit 1)
              )
              (path "/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000b1/00000000-0000-4000-8000-0000000000d1"
                (reference "R201")
                (unit 1)
              )
            )
          )
        )
      )`;

      await writeFile(rootSch, rootContent, 'utf8');
      await writeFile(chanSch, chanContent, 'utf8');
      await writeFile(leafSch, leafContent, 'utf8');

      const syms = await listSymbols(rootSch);
      expect(syms.map((s) => ({ ref: s.ref, sheet: s.sheet, unit: s.unit }))).toEqual([
        { ref: 'R101', sheet: 'ChanA/Filter', unit: 1 },
        { ref: 'R201', sheet: 'ChanB/Filter', unit: 1 },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('scopes instance lookup to active KiCad project and ignores stale project blocks', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { writeFile } = await import('node:fs/promises');
      const rootSch = path.join(repo, 'current.kicad_sch');
      const chanSch = path.join(repo, 'chan.kicad_sch');

      const rootContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-000000000001")
        (lib_symbols)
        (sheet
          (at 20 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000a1")
          (property "Sheetname" "Chan" (at 20 19 0))
          (property "Sheetfile" "chan.kicad_sch" (at 20 41 0))
        )
      )`;

      const chanContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000c1")
        (lib_symbols
          (symbol "Device:R"
            (property "Reference" "R" (at 0 0 0))
            (property "Value" "R" (at 0 0 0))
          )
        )
        (symbol
          (lib_id "Device:R")
          (at 10 10 0)
          (property "Reference" "R?" (at 10 10 0))
          (property "Value" "10k" (at 10 10 0))
          (instances
            (project "stale"
              (path "/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1"
                (reference "R900")
                (unit 1)
              )
            )
            (project "current"
              (path "/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1"
                (reference "R101")
                (unit 1)
              )
            )
          )
        )
      )`;

      await writeFile(rootSch, rootContent, 'utf8');
      await writeFile(chanSch, chanContent, 'utf8');

      const syms = await listSymbols(rootSch);
      expect(syms.map((s) => s.ref)).toEqual(['R101']);
    } finally {
      await cleanup();
    }
  });

  it('rejects conflicting exact paths across unselected projects and falls back to legacy direct instances', () => {
    // 1. Conflicting exact paths across projects with unselected active project
    const [conflictSym] = parseSexp(`(symbol
      (property "Reference" "R?" (at 0 0 0))
      (instances
        (project "projA"
          (path "/root/chan" (reference "R900") (unit 1))
        )
        (project "projB"
          (path "/root/chan" (reference "R101") (unit 1))
        )
      )
    )`);
    // Should NOT silently choose first project ("R900")
    expect(instanceForPath(conflictSym as any, '/root/chan', 'unrelated')).toBeNull();

    // Matching project succeeds
    expect(instanceForPath(conflictSym as any, '/root/chan', 'projB')).toEqual({ ref: 'R101', unit: 1 });

    // Non-conflicting exact paths across projects succeed (single match and agreeing multi-match)
    const [nonConflictSym] = parseSexp(`(symbol
      (instances
        (project "projA"
          (path "/other/path" (reference "R900") (unit 1))
        )
        (project "projB"
          (path "/root/chan" (reference "R101") (unit 1))
        )
      )
    )`);
    expect(instanceForPath(nonConflictSym as any, '/root/chan', 'unrelated')).toEqual({ ref: 'R101', unit: 1 });

    const [agreeingProjectsSym] = parseSexp(`(symbol
      (instances
        (project "projA"
          (path "/root/chan" (reference "R101") (unit 1))
        )
        (project "projB"
          (path "/root/chan" (reference "R101") (unit 1))
        )
      )
    )`);
    expect(instanceForPath(agreeingProjectsSym as any, '/root/chan', 'unrelated')).toEqual({ ref: 'R101', unit: 1 });

    // 2. Legacy direct instances without project block
    const [legacySym] = parseSexp(`(symbol
      (instances
        (path "/root/chan" (reference "R42") (unit 1))
      )
    )`);
    expect(instanceForPath(legacySym as any, '/root/chan', 'anyProject')).toEqual({ ref: 'R42', unit: 1 });

    // 3. Ambiguous suffix matches are rejected, unique suffix matches succeed
    const [ambigSym] = parseSexp(`(symbol
      (instances
        (project "p"
          (path "/branch1/sub/sheet" (reference "R11") (unit 1))
          (path "/branch2/sub/sheet" (reference "R12") (unit 1))
        )
      )
    )`);
    expect(instanceForPath(ambigSym as any, '/sub/sheet', 'p')).toBeNull();

    const [uniqueSuffixSym] = parseSexp(`(symbol
      (instances
        (project "p"
          (path "/only/one/sub/sheet" (reference "R11") (unit 1))
        )
      )
    )`);
    expect(instanceForPath(uniqueSuffixSym as any, '/sub/sheet', 'p')).toEqual({ ref: 'R11', unit: 1 });
  });

  it('prevents cycle loops without suppressing sibling placements', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { writeFile } = await import('node:fs/promises');
      const rootSch = path.join(repo, 'cycle_root.kicad_sch');
      const loopSch = path.join(repo, 'loop.kicad_sch');
      const siblingSch = path.join(repo, 'sibling.kicad_sch');

      const rootContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-000000000001")
        (lib_symbols)
        (sheet
          (at 20 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000a1")
          (property "Sheetname" "LoopSheet" (at 20 19 0))
          (property "Sheetfile" "loop.kicad_sch" (at 20 41 0))
        )
        (sheet
          (at 60 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000b1")
          (property "Sheetname" "SiblingSheet" (at 60 19 0))
          (property "Sheetfile" "sibling.kicad_sch" (at 60 41 0))
        )
      )`;

      const loopContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000c1")
        (lib_symbols)
        (sheet
          (at 20 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000d1")
          (property "Sheetname" "RecurseRoot" (at 20 19 0))
          (property "Sheetfile" "cycle_root.kicad_sch" (at 20 41 0))
        )
      )`;

      const siblingContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000e1")
        (lib_symbols
          (symbol "Device:R"
            (property "Reference" "R" (at 0 0 0))
            (property "Value" "R" (at 0 0 0))
          )
        )
        (symbol
          (lib_id "Device:R")
          (at 10 10 0)
          (property "Reference" "R_SIB" (at 10 10 0))
          (property "Value" "10k" (at 10 10 0))
        )
      )`;

      await writeFile(rootSch, rootContent, 'utf8');
      await writeFile(loopSch, loopContent, 'utf8');
      await writeFile(siblingSch, siblingContent, 'utf8');

      const syms = await listSymbols(rootSch);
      expect(syms.map((s) => s.ref)).toEqual(['R_SIB']);
    } finally {
      await cleanup();
    }
  });

  it('resolves per-instance units and pins for multi-unit symbols', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { writeFile } = await import('node:fs/promises');
      const rootSch = path.join(repo, 'multi_unit.kicad_sch');
      const dualSch = path.join(repo, 'dual.kicad_sch');

      const rootContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-000000000001")
        (lib_symbols)
        (sheet
          (at 20 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000a1")
          (property "Sheetname" "UnitA" (at 20 19 0))
          (property "Sheetfile" "dual.kicad_sch" (at 20 41 0))
        )
        (sheet
          (at 60 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000b1")
          (property "Sheetname" "UnitB" (at 60 19 0))
          (property "Sheetfile" "dual.kicad_sch" (at 60 41 0))
        )
      )`;

      const dualContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000c1")
        (lib_symbols
          (symbol "Amplifier_Operational:LM358"
            (property "Reference" "U" (at 0 0 0))
            (property "Value" "LM358" (at 0 0 0))
            (symbol "LM358_1_1"
              (pin output line (at 0 0 0) (length 2.54)
                (name "OUTA" (effects (font (size 1.27 1.27))))
                (number "1" (effects (font (size 1.27 1.27))))
              )
            )
            (symbol "LM358_2_1"
              (pin output line (at 0 0 0) (length 2.54)
                (name "OUTB" (effects (font (size 1.27 1.27))))
                (number "7" (effects (font (size 1.27 1.27))))
              )
            )
          )
        )
        (symbol
          (lib_id "Amplifier_Operational:LM358")
          (at 10 10 0)
          (property "Reference" "U1" (at 10 10 0))
          (property "Value" "LM358" (at 10 10 0))
          (instances
            (project "multi_unit"
              (path "/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1"
                (reference "U1")
                (unit 1)
              )
              (path "/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000b1"
                (reference "U1")
                (unit 2)
              )
            )
          )
        )
      )`;

      await writeFile(rootSch, rootContent, 'utf8');
      await writeFile(dualSch, dualContent, 'utf8');

      const syms = await listSymbols(rootSch);
      expect(syms.map((s) => ({ ref: s.ref, sheet: s.sheet, unit: s.unit }))).toEqual([
        { ref: 'U1', sheet: 'UnitA', unit: 1 },
        { ref: 'U1', sheet: 'UnitB', unit: 2 },
      ]);

      const pins = await pinNets(rootSch);
      expect(pins).toEqual([
        { ref: 'U1', pinNumber: '1', pinName: 'OUTA', net: null },
        { ref: 'U1', pinNumber: '7', pinName: 'OUTB', net: null },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('deduplicates reused sheet files in readSheetGeometry so wire metrics are not double-counted (#394)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { writeFile } = await import('node:fs/promises');
      const singleRoot = path.join(repo, 'single.kicad_sch');
      const reusedRoot = path.join(repo, 'reused.kicad_sch');
      const chanSch = path.join(repo, 'chan.kicad_sch');

      const singleContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-000000000001")
        (paper "A4")
        (lib_symbols)
        (sheet
          (at 20 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000a1")
          (property "Sheetname" "ChanA" (at 20 19 0))
          (property "Sheetfile" "chan.kicad_sch" (at 20 41 0))
        )
      )`;

      const reusedContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-000000000001")
        (paper "A4")
        (lib_symbols)
        (sheet
          (at 20 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000a1")
          (property "Sheetname" "ChanA" (at 20 19 0))
          (property "Sheetfile" "chan.kicad_sch" (at 20 41 0))
        )
        (sheet
          (at 60 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000b1")
          (property "Sheetname" "ChanB" (at 60 19 0))
          (property "Sheetfile" "chan.kicad_sch" (at 60 41 0))
        )
      )`;

      const chanContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000c1")
        (paper "A4")
        (lib_symbols)
        (wire (pts (xy 50 50) (xy 70 50)))
        (wire (pts (xy 70 50) (xy 70 60)))
        (wire (pts (xy 60 40) (xy 60 60)))
      )`;

      await writeFile(singleRoot, singleContent, 'utf8');
      await writeFile(reusedRoot, reusedContent, 'utf8');
      await writeFile(chanSch, chanContent, 'utf8');

      const singleGeom = await readSheetGeometry(singleRoot);
      const reusedGeom = await readSheetGeometry(reusedRoot);
      expect(reusedGeom.filter((g) => g.filePath === path.resolve(chanSch))).toHaveLength(1);

      const singleScore = scoreFromGeometry(singleGeom, await checkLegibility(singleRoot));
      const reusedScore = scoreFromGeometry(reusedGeom, await checkLegibility(reusedRoot));
      const metricRaw = (rep: typeof singleScore, name: string): number =>
        rep.metrics.find((m) => m.name === name)!.raw;

      expect(metricRaw(reusedScore, 'wire-length')).toBe(metricRaw(singleScore, 'wire-length'));
      expect(metricRaw(reusedScore, 'wire-crossings')).toBe(metricRaw(singleScore, 'wire-crossings'));
      expect(metricRaw(reusedScore, 'wire-bends')).toBe(metricRaw(singleScore, 'wire-bends'));
    } finally {
      await cleanup();
    }
  });

  it('formats nested non-reused sheet names with full hierarchy chain and handles missing uuids or sheetfiles (#394)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { writeFile } = await import('node:fs/promises');
      const rootSch = path.join(repo, 'no_uuid_root.kicad_sch');
      const mcuSch = path.join(repo, 'mcu.kicad_sch');
      const powerSch = path.join(repo, 'power.kicad_sch');

      // Root has no (uuid), one sheet block missing Sheetfile, one missing (uuid), and duplicate placement uuids
      const rootContent = `(kicad_sch
        (version 20231120)
        (lib_symbols)
        (sheet
          (at 10 10) (size 10 10)
          (property "Sheetname" "MissingFile" (at 10 9 0))
        )
        (sheet
          (at 20 20) (size 20 20)
          (property "Sheetname" "MCU" (at 20 19 0))
          (property "Sheetfile" "mcu.kicad_sch" (at 20 41 0))
        )
        (sheet
          (at 60 20) (size 20 20)
          (uuid "dup-placement-uuid")
          (property "Sheetname" "Dup1" (at 60 19 0))
          (property "Sheetfile" "power.kicad_sch" (at 60 41 0))
        )
        (sheet
          (at 90 20) (size 20 20)
          (uuid "dup-placement-uuid")
          (property "Sheetname" "Dup2" (at 90 19 0))
          (property "Sheetfile" "power.kicad_sch" (at 90 41 0))
        )
      )`;

      const mcuContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000m1")
        (lib_symbols)
        (sheet
          (at 20 20) (size 20 20)
          (uuid "00000000-0000-4000-8000-0000000000p1")
          (property "Sheetname" "Power" (at 20 19 0))
          (property "Sheetfile" "power.kicad_sch" (at 20 41 0))
        )
      )`;

      const powerContent = `(kicad_sch
        (version 20231120)
        (uuid "00000000-0000-4000-8000-0000000000p2")
        (lib_symbols
          (symbol "Device:C"
            (property "Reference" "C" (at 0 0 0))
            (property "Value" "C" (at 0 0 0))
          )
        )
        (symbol
          (lib_id "Device:C")
          (at 10 10 0)
          (property "Reference" "C1" (at 10 10 0))
          (property "Value" "100n" (at 10 10 0))
          (instances
            (project "no_uuid_root"
              (path "/MCU#1/00000000-0000-4000-8000-0000000000p1"
                (reference "C10")
                (unit 1)
              )
              (path "/dup-placement-uuid"
                (reference "C20")
                (unit 1)
              )
            )
          )
        )
      )`;

      await writeFile(rootSch, rootContent, 'utf8');
      await writeFile(mcuSch, mcuContent, 'utf8');
      await writeFile(powerSch, powerContent, 'utf8');

      const syms = await listSymbols(rootSch);
      expect(syms.map((s) => ({ ref: s.ref, sheet: s.sheet }))).toEqual([
        { ref: 'C10', sheet: 'MCU/Power' },
        { ref: 'C20', sheet: 'Dup1' },
      ]);
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

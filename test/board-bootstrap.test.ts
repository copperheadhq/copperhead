/**
 * Board bootstrap for the layout-draft stage: the schematic's parts go onto
 * the scaffold board deterministically so the stage edits placements instead
 * of authoring footprints. The populate test needs kicad-cli (netlist export
 * and the load probe) and the stock footprint libraries; it skips when either
 * is missing, the pure helpers never do.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import {
  parseNetlist,
  instantiateFootprint,
  shelfPack,
  populateBoard,
  footprintSearchDirs,
  resolveFootprint,
  layoutDocSeed,
  boardHasFootprints,
} from '../src/kicad/board.js';
import { symbolSearchDirs } from '../src/kicad/symlib.js';
import { runDrc } from '../src/kicad/cli.js';
import { FIXTURE } from './helpers.js';

const SCAFFOLD_BOARD = `(kicad_pcb
	(version 20240108)
	(generator "pcbnew")
	(generator_version "8.0")
	(general
		(thickness 1.6)
		(legacy_teardrops no)
	)
	(paper "A4")
	(layers
		(0 "F.Cu" signal)
		(31 "B.Cu" signal)
		(34 "B.Paste" user)
		(35 "F.Paste" user)
		(36 "B.SilkS" user "B.Silkscreen")
		(37 "F.SilkS" user "F.Silkscreen")
		(38 "B.Mask" user)
		(39 "F.Mask" user)
		(44 "Edge.Cuts" user)
		(46 "B.CrtYd" user "B.Courtyard")
		(47 "F.CrtYd" user "F.Courtyard")
		(48 "B.Fab" user)
		(49 "F.Fab" user)
	)
	(setup
		(pad_to_mask_clearance 0)
		(allow_soldermask_bridges_in_footprints no)
	)
	(net 0 "")
	(gr_rect (start 100 100) (end 130 120)
		(stroke (width 0.1) (type default))
		(layer "Edge.Cuts")
		(uuid "00000000-0000-4000-8000-000000000001")
	)
)
`;

const LIB_FP = `(footprint "R_0603_1608Metric"
	(version 20240108)
	(generator "kicad-footprint-generator")
	(layer "F.Cu")
	(descr "Resistor SMD 0603")
	(property "Reference" "REF**"
		(at 0 -1.43 0)
		(layer "F.SilkS")
	)
	(property "Value" "R_0603_1608Metric"
		(at 0 1.43 0)
		(layer "F.Fab")
	)
	(fp_rect (start -1.48 -0.73) (end 1.48 0.73) (layer "F.CrtYd"))
	(pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste"))
	(pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste"))
)
`;

async function withTmpDir(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = path.join(os.tmpdir(), `copperhead-board-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
  } catch {
    return false;
  }
  return (await footprintSearchDirs()).length > 0;
}

describe('parseNetlist', () => {
  it('reads components (no power symbols) and nets with their nodes', () => {
    const n = parseNetlist(`(export (version "E")
      (components
        (comp (ref "R1") (value "10k") (footprint "Resistor_SMD:R_0603_1608Metric") (libsource (lib "Device") (part "R")))
        (comp (ref "#PWR01") (value "GND") (libsource (lib "power") (part "GND"))))
      (nets
        (net (code "1") (name "GND") (node (ref "R1") (pin "2")) (node (ref "#PWR01") (pin "1")))
        (net (code "2") (name "SIG") (node (ref "R1") (pin "1")))))`);
    expect(n.parts).toEqual([{ ref: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric', libId: 'Device:R' }]);
    expect(n.nets.get('GND')).toEqual([['R1', '2']]);
    expect(n.nets.get('SIG')).toEqual([['R1', '1']]);
  });
});

describe('instantiateFootprint', () => {
  it('names the lib id, drops library headers, sets ref/value/at, and assigns pad nets', () => {
    const out = instantiateFootprint(
      LIB_FP,
      'Resistor_SMD:R_0603_1608Metric',
      'R7',
      '4.7k',
      { x: 105.5, y: 110 },
      new Map([
        ['1', { code: 3, name: 'SIG' }],
        ['2', { code: 1, name: 'GND' }],
      ]),
      'seed',
    );
    expect(out).toMatch(/^\t\(footprint "Resistor_SMD:R_0603_1608Metric"/);
    expect(out).not.toMatch(/\(version |\(generator /);
    expect(out).toMatch(/\(uuid "[0-9a-f-]{36}"\)/);
    expect(out).toMatch(/\(at 105\.5 110\)/);
    expect(out).toMatch(/\(property "Reference" "R7"/);
    expect(out).toMatch(/\(property "Value" "4.7k"/);
    expect(out).toMatch(/\(pad "1" smd roundrect\n\t\t\t\(net 3 "SIG"\)/);
    expect(out).toMatch(/\(pad "2" smd roundrect\n\t\t\t\(net 1 "GND"\)/);
  });
  it('leaves a pad without a net alone', () => {
    const out = instantiateFootprint(LIB_FP, 'L:N', 'R1', 'x', { x: 0, y: 0 }, new Map(), 's');
    expect(out).not.toMatch(/\(net /);
  });
});

describe('shelfPack', () => {
  it('never overlaps boxes and wraps into rows', () => {
    const boxes = Array.from({ length: 9 }, (_, i) => ({ w: 4 + i, h: 3 }));
    const o = shelfPack(boxes, 1);
    for (let i = 0; i < o.length; i++) {
      for (let j = i + 1; j < o.length; j++) {
        const a = { ...o[i]!, ...boxes[i]! }, b = { ...o[j]!, ...boxes[j]! };
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
    expect(new Set(o.map((p) => p.y)).size).toBeGreaterThan(1);
  });
});

describe('layoutDocSeed', () => {
  it('lists the placements and never writes the Draft quality marker', () => {
    const doc = layoutDocSeed(
      {
        placed: [{ ref: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric', requested: 'Device:R', how: 'generic-default', x: 1, y: 2 }],
        unplaced: [{ ref: 'U9', value: 'X', requested: 'Nope:Nope', reason: 'not installed' }],
        nets: 3,
        outline: { width: 20, height: 12 },
      },
      'b.kicad_pcb',
    );
    expect(doc).toMatch(/## Footprints/);
    expect(doc).toMatch(/\| R1 \| 10k \| Resistor_SMD:R_0603_1608Metric \| generic default package/);
    expect(doc).toMatch(/### Not placed[\s\S]*U9/);
    expect(doc).not.toMatch(/Draft quality/);
  });
});

describe('populateBoard (needs kicad-cli and the stock footprint libraries)', async () => {
  const ok = await haveKicad();
  it.skipIf(!ok)('places the open-key parts, assigns nets, resizes the outline, and the board passes DRC with only unrouted connections', async () => {
    await withTmpDir(async (root) => {
      await copyFile(path.join(FIXTURE, 'hardware', 'open-key.kicad_sch'), path.join(root, 'open-key.kicad_sch'));
      await writeFile(path.join(root, 'b.kicad_pcb'), SCAFFOLD_BOARD, 'utf8');
      expect(await boardHasFootprints(path.join(root, 'b.kicad_pcb'))).toBe(false);
      const r = await populateBoard(root, 'open-key.kicad_sch', 'b.kicad_pcb');
      // R1/R2 name an installed footprint; the fixture MCU's footprint is not installed on a stock machine
      expect(r.placed.map((p) => p.ref)).toEqual(expect.arrayContaining(['R1', 'R2']));
      expect(r.nets).toBeGreaterThan(0);
      const text = await readFile(path.join(root, 'b.kicad_pcb'), 'utf8');
      expect((text.match(/^\t\(footprint /gm) ?? []).length).toBe(r.placed.length);
      expect(text).toMatch(/\(net \d+ "GND"\)/);
      // one outline, resized
      expect((text.match(/\(layer "Edge\.Cuts"\)/g) ?? []).length).toBe(1);
      expect(text).not.toMatch(/\(end 130 120\)/);
      expect(await boardHasFootprints(path.join(root, 'b.kicad_pcb'))).toBe(true);
      const drc = await runDrc(path.join(root, 'b.kicad_pcb'));
      expect(drc.violations).toEqual([]);
      expect(drc.ok).toBe(true);
    });
  }, 120_000);

  it.skipIf(!ok)('resolves a symbol id in the footprint field through the library and the generic table', async () => {
    const fp = await footprintSearchDirs();
    const sym = await symbolSearchDirs();
    const led = await resolveFootprint({ ref: 'D1', value: 'LED', footprint: 'Device:LED', libId: 'Device:LED' }, new Set(['1', '2']), fp, sym);
    expect('fpId' in led && led.fpId).toBe('LED_SMD:LED_0603_1608Metric');
    expect('how' in led && led.how).toBe('generic-default');
    const exact = await resolveFootprint(
      { ref: 'R1', value: '1k', footprint: 'Resistor_SMD:R_0603_1608Metric', libId: 'Device:R' },
      new Set(['1', '2']),
      fp,
      sym,
    );
    expect('how' in exact && exact.how).toBe('schematic');
    const none = await resolveFootprint({ ref: 'U9', value: 'X', footprint: 'Nope:Nope', libId: 'Nope:Nope' }, new Set(), fp, sym);
    expect('reason' in none).toBe(true);
  }, 60_000);
});

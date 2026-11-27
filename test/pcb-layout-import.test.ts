/**
 * KiCad board import (RFC 11 §6, ADR 0004, implementation spec §4.2).
 * The transform cases carry numbers read from pcbnew on a KiCad 10 board;
 * the demo and oracle cases run only where KiCad's demos or pcbnew exist.
 */
import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { importBoard, arcPoints, UnsupportedBoardVersion, MAX_BOARD_VERSION } from '../src/pcb/ir/kicad/import.js';
import { topLevelBlocks, childBlocks, stripChildren } from '../src/pcb/ir/kicad/blocks.js';
import { mmToNm } from '../src/pcb/ir/units.js';
import { area, bbox, centroid } from '../src/pcb/ir/geometry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'microboards');
const DEMOS = '/usr/share/kicad/demos';
const mm = mmToNm;

const HEADER = `(kicad_pcb (version 20240108) (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user) (46 "B.CrtYd" user "B.Courtyard") (47 "F.CrtYd" user "F.Courtyard"))
  (net 0 "") (net 1 "GND") (net 2 "SIG")
  (gr_rect (start 100 100) (end 200 200) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "o"))
`;

function twoPad(ref: string, layer: string, at: string, padRot: number, sizeW = 0.4, sizeH = 0.6, offset = 0.45): string {
  return `  (footprint "lib:two" (layer "${layer}") (uuid "${ref}-id") (at ${at})
    (property "Reference" "${ref}" (at 0 0 0) (layer "F.SilkS"))
    (property "Value" "V" (at 0 0 0) (layer "F.Fab"))
    (attr smd)
    (fp_rect (start -0.75 -0.4) (end 0.75 0.4) (stroke (width 0.05) (type default)) (layer "${layer === 'B.Cu' ? 'B' : 'F'}.CrtYd"))
    (pad "1" smd roundrect (at -${offset} 0 ${padRot}) (size ${sizeW} ${sizeH}) (layers "${layer}") (roundrect_rratio 0.25) (net 1 "GND") (uuid "${ref}-p1"))
    (pad "2" smd roundrect (at ${offset} 0 ${padRot}) (size ${sizeW} ${sizeH}) (layers "${layer}") (roundrect_rratio 0.25) (net 2 "SIG") (uuid "${ref}-p2"))
  )
`;
}

describe('block scanner', () => {
  it('finds top-level records and strips children by head', () => {
    const text = `${HEADER}  (segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net 1) (uuid "s"))\n)\n`;
    const heads = topLevelBlocks(text).map((b) => b.head);
    expect(heads).toEqual(['version', 'generator', 'layers', 'net', 'net', 'net', 'gr_rect', 'segment']);
    const zone = '(zone (net 1) (polygon (pts (xy 0 0))) (filled_polygon (layer "F.Cu") (pts (xy 1 1))) (filled_polygon (layer "B.Cu") (pts (xy 2 2))))';
    expect(stripChildren(zone, 'filled_polygon')).toBe('(zone (net 1) (polygon (pts (xy 0 0))))');
    expect(childBlocks(zone).map((b) => b.head)).toEqual(['net', 'polygon', 'filled_polygon', 'filled_polygon']);
  });
});

describe('pad transform (numbers from pcbnew on the StickHub demo)', () => {
  it('front footprint rotated -90 (D4)', () => {
    const { design } = importBoard({ boardText: `${HEADER}${twoPad('D4', 'F.Cu', '150.4 96.75 -90', 270)}\n)`, boardPath: 'b.kicad_pcb', now: 't' });
    const d4 = design.components[0]!;
    expect(d4.rotation).toBe(270_000);
    expect(d4.attributes.side).toBe('front');
    expect(d4.pads.map((p) => p.at)).toEqual([{ x: mm(150.4), y: mm(96.3) }, { x: mm(150.4), y: mm(97.2) }]);
    expect(centroid(d4.pads[0]!.copper)).toEqual({ x: mm(150.4), y: mm(96.3) });
    // rotated pad copper: 0.4 x 0.6 pad turned 270 -> 0.6 wide, 0.4 tall
    const b = bbox(d4.pads[0]!.copper);
    expect(b.maxX - b.minX).toBe(mm(0.6));
    expect(b.maxY - b.minY).toBe(mm(0.4));
    expect(d4.pads[0]!.netId).toBe(design.nets.find((n) => n.name === 'GND')!.id);
  });

  it('back footprint rotated 45 (C36): same transform, no mirroring', () => {
    const { design } = importBoard({ boardText: `${HEADER}${twoPad('C36', 'B.Cu', '151.392893 88.342893 45', 45, 0.55, 0.8, 0.675)}\n)`, boardPath: 'b.kicad_pcb', now: 't' });
    const c = design.components[0]!;
    expect(c.attributes.side).toBe('back');
    const p1 = c.pads[0]!.at;
    expect(Math.abs(p1.x - mm(150.915596))).toBeLessThanOrEqual(1000);
    expect(Math.abs(p1.y - mm(88.82019))).toBeLessThanOrEqual(1000);
    const p2 = c.pads[1]!.at;
    expect(Math.abs(p2.x - mm(151.87019))).toBeLessThanOrEqual(1000);
    expect(Math.abs(p2.y - mm(87.865596))).toBeLessThanOrEqual(1000);
    expect(c.pads[0]!.layers).toEqual(['B.Cu']);
    expect(c.footprint.courtyard).not.toBeNull();
  });

  it('refuses a board newer than the pinned format', () => {
    expect(() => importBoard({ boardText: `(kicad_pcb (version ${MAX_BOARD_VERSION + 1}))`, boardPath: 'b' })).toThrow(UnsupportedBoardVersion);
  });

  it('approximates arcs through their midpoint', () => {
    const pts = arcPoints({ x: mm(10), y: 0 }, { x: mm(7.071068), y: mm(7.071068) }, { x: 0, y: mm(10) });
    expect(pts.length).toBeGreaterThan(10);
    for (const p of pts) expect(Math.abs(Math.hypot(p.x, p.y) - mm(10))).toBeLessThan(mm(0.001));
  });
});

const goldenCases = (await readdir(GOLDEN, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();

describe('golden microboards import cleanly', () => {
  const cases = goldenCases;
  it.each(cases)('%s', async (name) => {
    const dir = path.join(GOLDEN, name);
    const { design, warnings } = importBoard({
      boardText: await readFile(path.join(dir, 'board.kicad_pcb'), 'utf8'),
      boardPath: `test/fixtures/microboards/${name}/board.kicad_pcb`,
      projectText: await readFile(path.join(dir, 'board.kicad_pro'), 'utf8'),
      now: 't',
    });
    expect(design.lossy).toEqual([]);
    expect(warnings).toEqual([]);
    expect(design.components.length).toBeGreaterThan(0);
    for (const c of design.components) {
      expect(c.reference).toMatch(/^[A-Z]+\d+$/);
      expect(c.footprint.courtyard, `${name}/${c.reference} courtyard`).not.toBeNull();
      expect(c.pads.length).toBeGreaterThan(0);
    }
    expect(area(design.board.outline)).toBeGreaterThan(mm(20) * mm(20));
    // every net has every pad the board file assigns it
    const assigned = design.components.flatMap((c) => c.pads).filter((p) => p.netId).length;
    expect(design.nets.reduce((s, n) => s + n.padIds.length, 0)).toBe(assigned);
    expect(design.board.rules.trackWidthNm).toBe(mm(0.25));
    expect(design.board.rules.copperEdgeClearanceNm).toBe(mm(0.3));
    expect(design.source.contentHash).toHaveLength(64);
  });

  it('keepout: a rule area becomes a keepout with its prohibitions', async () => {
    // the golden keepout board now carries its ring as intent; this fixture is the earlier rule-area version
    const { design } = importBoard({ boardText: await readFile(path.join(HERE, 'fixtures', 'pcb', 'keepout-rule-area.kicad_pcb'), 'utf8'), boardPath: 'k', now: 't' });
    expect(design.board.keepouts).toHaveLength(1);
    expect(design.board.keepouts[0]!.prohibits.sort()).toEqual(['copper', 'footprints', 'pads', 'tracks', 'vias']);
    expect(design.routing.zones[0]!.isKeepout).toBe(true);
    expect(design.routing.zones[0]!.definitionText).toContain('(keepout');
  });

  it('clearance: segments carry net, layer, width, and endpoints', async () => {
    const { design } = importBoard({ boardText: await readFile(path.join(GOLDEN, 'clearance', 'board.kicad_pcb'), 'utf8'), boardPath: 'c', now: 't' });
    expect(design.routing.segments).toHaveLength(4);
    const sig1 = design.nets.find((n) => n.name === 'SIG1')!;
    expect(design.routing.segments.filter((s) => s.netId === sig1.id)).toHaveLength(2);
    expect(design.routing.segments[0]!.width).toBe(mm(0.25));
    expect(design.routing.segments[0]!.layer).toBe('F.Cu');
  });
});

describe('KiCad demo boards (skipped when the demos are not installed)', () => {
  it('StickHub: 94 footprints, back-side parts, zones with definitions but no fills', async () => {
    const f = path.join(DEMOS, 'stickhub', 'StickHub.kicad_pcb');
    if (!existsSync(f)) return;
    const { design } = importBoard({ boardText: await readFile(f, 'utf8'), boardPath: 'StickHub.kicad_pcb', projectText: await readFile(f.replace('.kicad_pcb', '.kicad_pro'), 'utf8'), now: 't' });
    expect(design.components).toHaveLength(94);
    expect(design.components.some((c) => c.attributes.side === 'back')).toBe(true);
    expect(design.routing.zones.length).toBeGreaterThan(0);
    for (const z of design.routing.zones) expect(z.definitionText).not.toContain('filled_polygon');
    expect(design.routing.segments.length).toBeGreaterThan(1000);
    expect(design.board.layers.filter((l) => l.kind === 'copper').map((l) => l.id)).toEqual(['F.Cu', 'B.Cu']);
    expect(design.board.rules.clearanceNm).toBe(mm(0.15));
  });

  it('ecc83: renamed copper layers are carried through', async () => {
    const f = path.join(DEMOS, 'ecc83', 'ecc83-pp.kicad_pcb');
    if (!existsSync(f)) return;
    const { design } = importBoard({ boardText: await readFile(f, 'utf8'), boardPath: 'ecc83-pp.kicad_pcb', now: 't' });
    const copper = design.board.layers.filter((l) => l.kind === 'copper');
    expect(copper.map((l) => l.id)).toEqual(['F.Cu', 'B.Cu']);
    expect(copper.map((l) => l.userName)).toEqual(['top_cu', 'bottom_cu']);
    const layersUsed = new Set(design.components.flatMap((c) => c.pads.flatMap((p) => p.layers)));
    expect([...layersUsed].sort()).toEqual(['B.Cu', 'F.Cu']);
    for (const s of design.routing.segments) expect(['F.Cu', 'B.Cu']).toContain(s.layer);
  });
});

describe('pcbnew oracle (COPPERHEAD_TEST_PCBNEW=1)', () => {
  const boards = [
    path.join(DEMOS, 'stickhub', 'StickHub.kicad_pcb'),
    path.join(DEMOS, 'ecc83', 'ecc83-pp.kicad_pcb'),
    path.join(DEMOS, 'pic_programmer', 'pic_programmer.kicad_pcb'),
    path.join(GOLDEN, 'completion', 'board.kicad_pcb'),
  ];
  it.each(boards)('every pad position matches pcbnew within 1 um: %s', async (board) => {
    if (process.env.COPPERHEAD_TEST_PCBNEW !== '1' || !existsSync(board)) return;
    const python = process.env.COPPERHEAD_PCBNEW_PYTHON ?? '/usr/bin/python3';
    const res = await execa(python, [path.join(HERE, 'support', 'pcbnew-pads.py'), board], {
      env: { ...process.env, PYTHONPATH: process.env.COPPERHEAD_PCBNEW_PYTHONPATH ?? '/usr/lib/python3/dist-packages' },
      reject: false,
    });
    expect(res.exitCode, res.stderr.split('\n').filter((l) => !/wx|assert/i.test(l)).join('\n')).toBe(0);
    const oracle = JSON.parse(res.stdout) as { ref: string; side: string; pads: { n: string; x: number; y: number; w: number; h: number; layers: string[] }[] }[];
    const { design } = importBoard({ boardText: await readFile(board, 'utf8'), boardPath: board, now: 't' });
    const byRef = new Map(design.components.map((c) => [c.reference, c]));
    const copperCount = design.board.layers.filter((l) => l.kind === 'copper').length;
    let checked = 0;
    for (const fp of oracle) {
      const c = byRef.get(fp.ref);
      expect(c, fp.ref).toBeDefined();
      expect(c!.attributes.side).toBe(fp.side);
      for (const [i, op] of fp.pads.entries()) {
        const pad = c!.pads[i]!;
        expect(pad.number).toBe(op.n);
        expect(Math.abs(pad.at.x - mm(op.x)), `${fp.ref}.${op.n} x`).toBeLessThanOrEqual(1000);
        expect(Math.abs(pad.at.y - mm(op.y)), `${fp.ref}.${op.n} y`).toBeLessThanOrEqual(1000);
        expect(pad.size).toEqual({ w: mm(op.w), h: mm(op.h) });
        // pcbnew reports every copper slot (32) for a through-hole pad; the IR lists the board's copper layers
        expect(pad.layers.length).toBe(Math.min(op.layers.length, copperCount));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});

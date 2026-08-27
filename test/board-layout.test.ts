import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseNetlist, readNetlist } from '../src/kicad/netlist.js';
import { resolveFootprint, parseFootprint } from '../src/kicad/fplib.js';
import { buildBoard, emitBoard, emitRoutedBoard } from '../src/kicad/board.js';
import { placeBoard } from '../src/kicad/layout/placement.js';
import { populateBoard } from '../src/kicad/layout/layout.js';
import { runDrc } from '../src/kicad/cli.js';
import type { Netlist } from '../src/kicad/netlist.js';

const FIXTURE_SCH = path.resolve('test/fixtures/open-key/hardware/open-key.kicad_sch');

const R0603 = 'Resistor_SMD:R_0603_1608Metric';

describe('board population (issue #252)', () => {
  it('parses a KiCad s-expression netlist', async () => {
    const n = await readNetlist(FIXTURE_SCH);
    expect(n.components.map((c) => c.ref)).toEqual(['R1', 'R2', 'U1']);
    expect(n.components.find((c) => c.ref === 'R1')!.footprint).toBe(R0603);
    // 4 real nets (>= 2 nodes) + 4 no-connect single-node nets
    expect(n.nets.filter((x) => x.nodes.length >= 2)).toHaveLength(4);
  });

  it('resolves footprint pad geometry from the installed libraries', async () => {
    const def = await resolveFootprint(R0603);
    expect(def).not.toBeNull();
    expect(def!.pads).toHaveLength(2);
    expect(def!.pads[0]!.number).toBe('1');
    expect(def!.pads[0]!.width).toBeCloseTo(0.8, 3);
    expect(def!.courtyard).not.toBeNull();
  });

  it('reports footprints missing from the installed libraries rather than skipping silently', async () => {
    // The fixture references RF_Module:ESP32-S3-MINI-1, which is not in the
    // installed KiCad 9 footprint set — so U1 is reported unresolved.
    const { unresolved } = await populateBoard(FIXTURE_SCH);
    expect(unresolved.some((u) => u.ref === 'U1')).toBe(true);
  });

  it('assigns pad nets and emits a loadable, hard-clean board', async () => {
    const def = (await resolveFootprint(R0603))!;
    const resolver = async (libId: string) => (libId === R0603 ? def : null);
    const netlist: Netlist = {
      components: [
        { ref: 'R1', value: '10k', footprint: R0603 },
        { ref: 'R2', value: '1k', footprint: R0603 },
      ],
      nets: [{ name: 'NET1', nodes: [{ ref: 'R1', pin: '1' }, { ref: 'R2', pin: '1' }] }],
    };

    const { board, unresolved } = await buildBoard(netlist, resolver);
    expect(unresolved).toEqual([]);
    expect(board.footprints).toHaveLength(2);
    expect(board.nets).toHaveLength(1);
    // Both pad "1"s carry NET1; pad "2"s are unconnected (net 0).
    expect(board.footprints[0]!.pads.find((p) => p.number === '1')!.net).toBe('NET1');
    expect(board.footprints[0]!.pads.find((p) => p.number === '2')!.net).toBe('');

    placeBoard(board);
    expect(board.width).toBeGreaterThan(0);
    expect(board.height).toBeGreaterThan(0);

    const text = emitBoard(board, 'test');
    expect(text).toContain('(footprint "Resistor_SMD:R_0603_1608Metric"');
    expect(text).toContain('(net 1 "NET1")');

    const dir = await mkdtemp(path.join(tmpdir(), 'ch-board-'));
    const pcb = path.join(dir, 'test.kicad_pcb');
    try {
      await writeFile(pcb, text, 'utf8');
      const drc = await runDrc(pcb);
      // One unrouted net (ratsnest), and no error-severity violations beyond it
      // (warnings like library-footprint mismatch are ignorable for a draft).
      expect(drc.unrouted.length).toBe(1);
      const errors = drc.violations.filter((v) => v.severity === 'error').length;
      const unroutedErrors = drc.unrouted.filter((v) => v.severity === 'error').length;
      expect(errors - unroutedErrors).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('parseFootprint is deterministic for the same source', async () => {
    const raw = await readFile('/usr/share/kicad/footprints/Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod', 'utf8');
    const a = parseFootprint(raw, R0603);
    const b = parseFootprint(raw, R0603);
    expect(a).toEqual(b);
  });

  it('emits unique, deterministic UUIDs across multiple wires on the same net', () => {
    const board = {
      width: 10,
      height: 10,
      footprints: [
        {
          ref: 'R1',
          footprint: R0603,
          value: '10k',
          x: 2,
          y: 2,
          rotation: 0,
          side: 'front' as const,
          pads: [
            { number: '1', net: 'N$1', x: -0.5, y: 0, width: 0.8, height: 0.8, layers: ['F.Cu'] },
            { number: '2', net: 'N$1', x: 0.5, y: 0, width: 0.8, height: 0.8, layers: ['F.Cu'] },
          ],
        },
      ],
      nets: [{ name: 'N$1', pins: [{ ref: 'R1', pad: '1' }, { ref: 'R1', pad: '2' }] }],
    };
    // Two wires on the same net, each a single segment: the pre-fix emitter keyed
    // both segments on `route/N$1/0` and produced the same UUID.
    const routed = {
      tracks: [
        { net: 'N$1', layer: 'F.Cu' as const, width: 0.25, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
        { net: 'N$1', layer: 'F.Cu' as const, width: 0.25, points: [{ x: 1, y: 0 }, { x: 2, y: 0 }] },
      ],
      vias: [{ net: 'N$1', x: 1, y: 0, diameter: 0.6, drill: 0.3 }],
    };
    const text = emitRoutedBoard(board, 'test', routed);
    const uuids = [...text.matchAll(/\(uuid "([^"]+)"\)/g)].map((m) => m[1]!);
    expect(new Set(uuids).size).toBe(uuids.length);

    // Deterministic: the same routed board re-emits the same UUIDs.
    const again = emitRoutedBoard(board, 'test', routed);
    expect(again).toBe(text);
  });
});

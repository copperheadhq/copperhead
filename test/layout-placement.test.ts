import { describe, it, expect } from 'vitest';
import { GridPlacementEngine, footprintSize } from '../src/kicad/layout/placement.js';
import type { BoardModel, Netlist, PlacementConstraints } from '../src/kicad/layout/types.js';

const board: BoardModel = {
  width: 50,
  height: 30,
  footprints: [
    { ref: 'U1', footprint: 'Package_SO:SOIC-8', x: 0, y: 0, rotation: 0, side: 'front', courtyard: { width: 8, height: 5 }, pads: [] },
    { ref: 'R1', footprint: 'Resistor_SMD:R_0603', x: 0, y: 0, rotation: 0, side: 'front', courtyard: { width: 1.6, height: 0.8 }, pads: [] },
    { ref: 'C1', footprint: 'Capacitor_SMD:C_0603', x: 0, y: 0, rotation: 0, side: 'front', courtyard: { width: 1.6, height: 0.8 }, pads: [] },
    { ref: 'J1', footprint: 'Connector_USB:USB_C', x: 0, y: 0, rotation: 0, side: 'front', courtyard: { width: 9, height: 8 }, pads: [] },
  ],
  nets: [],
};

const netlist: Netlist = { nets: [] };
const constraints: PlacementConstraints = {};

describe('grid placement engine', () => {
  it('is deterministic (same board, same coordinates)', async () => {
    const engine = new GridPlacementEngine();
    const a = await engine.place(board, netlist, constraints);
    const b = await engine.place(board, netlist, constraints);
    expect(a).toEqual(b);
  });

  it('orders by area descending and packs without overlap inside the board', async () => {
    const engine = new GridPlacementEngine();
    const { footprints } = await engine.place(board, netlist, constraints);

    // Largest first: J1 (72) > U1 (40) > R1/C1 (1.28, tie breaks by ref ascending).
    expect(footprints.map((f) => f.ref)).toEqual(['J1', 'U1', 'C1', 'R1']);

    for (const fp of footprints) {
      const s = footprintSize(fp);
      expect(fp.x + s.width).toBeLessThanOrEqual(board.width);
      expect(fp.y + s.height).toBeLessThanOrEqual(board.height);
    }

    // No two bounding boxes may intersect.
    for (let i = 0; i < footprints.length; i++) {
      for (let j = i + 1; j < footprints.length; j++) {
        const a = footprints[i]!;
        const b = footprints[j]!;
        const sa = footprintSize(a);
        const sb = footprintSize(b);
        const overlapX = a.x < b.x + sb.width && b.x < a.x + sa.width;
        const overlapY = a.y < b.y + sb.height && b.y < a.y + sa.height;
        expect(overlapX && overlapY, `${a.ref} vs ${b.ref}`).toBe(false);
      }
    }
  });

  it('falls back to pad-extent size when a footprint has no courtyard', () => {
    const size = footprintSize({
      ref: 'X1',
      footprint: 'x',
      x: 0,
      y: 0,
      rotation: 0,
      side: 'front',
      pads: [
        { number: '1', net: '', x: 0, y: 0, width: 0.5, height: 0.5, layers: ['F.Cu'] },
        { number: '2', net: '', x: 2, y: 1, width: 0.5, height: 0.5, layers: ['F.Cu'] },
      ],
    });
    expect(size).toEqual({ width: 2.5, height: 1.5 });
  });
});

import { describe, it, expect } from 'vitest';
import { GridPlacementEngine, footprintSize, footprintExtents } from '../src/kicad/layout/placement.js';
import type { BoardModel, PlacedFootprint, PlacementConstraints } from '../src/kicad/layout/types.js';

/** Absolute board-space bounding box of a placed footprint. */
const abs = (fp: PlacedFootprint) => {
  const e = footprintExtents(fp);
  return { minX: fp.x + e.minX, minY: fp.y + e.minY, maxX: fp.x + e.maxX, maxY: fp.y + e.maxY };
};

const board: BoardModel = {
  width: 50,
  height: 30,
  footprints: [
    { ref: 'U1', footprint: 'Package_SO:SOIC-8', x: 0, y: 0, rotation: 0, side: 'front', courtyard: { minX: -4, minY: -2.5, maxX: 4, maxY: 2.5 }, pads: [] },
    { ref: 'R1', footprint: 'Resistor_SMD:R_0603', x: 0, y: 0, rotation: 0, side: 'front', courtyard: { minX: -0.8, minY: -0.4, maxX: 0.8, maxY: 0.4 }, pads: [] },
    { ref: 'C1', footprint: 'Capacitor_SMD:C_0603', x: 0, y: 0, rotation: 0, side: 'front', courtyard: { minX: -0.8, minY: -0.4, maxX: 0.8, maxY: 0.4 }, pads: [] },
    { ref: 'J1', footprint: 'Connector_USB:USB_C', x: 0, y: 0, rotation: 0, side: 'front', courtyard: { minX: -4.5, minY: -4, maxX: 4.5, maxY: 4 }, pads: [] },
  ],
  nets: [],
};

const constraints: PlacementConstraints = {};

describe('grid placement engine', () => {
  it('is deterministic (same board, same coordinates)', async () => {
    const engine = new GridPlacementEngine();
    const a = await engine.place(board, constraints);
    const b = await engine.place(board, constraints);
    expect(a).toEqual(b);
  });

  it('orders by area descending and packs without overlap inside the board', async () => {
    const engine = new GridPlacementEngine();
    const { footprints } = await engine.place(board, constraints);

    // Largest footprint (J1) is placed first, at the top-left of the board.
    const byX = [...footprints].sort((a, b) => a.x - b.x);
    expect(byX[0]!.ref).toBe('J1');

    for (const fp of footprints) {
      const e = abs(fp);
      expect(e.minX).toBeGreaterThanOrEqual(0);
      expect(e.minY).toBeGreaterThanOrEqual(0);
      expect(e.maxX).toBeLessThanOrEqual(board.width);
      expect(e.maxY).toBeLessThanOrEqual(board.height);
    }

    // No two bounding boxes may intersect.
    for (let i = 0; i < footprints.length; i++) {
      for (let j = i + 1; j < footprints.length; j++) {
        const a = abs(footprints[i]!);
        const b = abs(footprints[j]!);
        const overlapX = a.minX < b.maxX && b.minX < a.maxX;
        const overlapY = a.minY < b.maxY && b.minY < a.maxY;
        expect(overlapX && overlapY, `${footprints[i]!.ref} vs ${footprints[j]!.ref}`).toBe(false);
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

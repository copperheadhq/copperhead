import { describe, it, expect } from 'vitest';
import { connectivityOrder, placeBoard } from '../src/kicad/layout/placement.js';
import type { BoardModel, PlacedFootprint } from '../src/kicad/layout/types.js';

/**
 * Regression tests for the connectivity-aware ordering (issue #141): the order
 * must cluster components that share low-fanout signal nets, must not be
 * diluted by a global power star, and must stay deterministic — all without
 * reading a specific design's refdes or the golden board.
 */

function fp(ref: string, courtyard: { minX: number; minY: number; maxX: number; maxY: number }): PlacedFootprint {
  return { ref, footprint: `lib:${ref}`, x: 0, y: 0, rotation: 0, side: 'front', courtyard, pads: [] };
}

const IC = { minX: -4, minY: -2.5, maxX: 4, maxY: 2.5 };
const PASSIVE = { minX: -0.8, minY: -0.4, maxX: 0.8, maxY: 0.4 };

describe('connectivity-aware placement ordering', () => {
  it('places components that share a net consecutively (cap beside its IC)', () => {
    const board: BoardModel = {
      width: 0,
      height: 0,
      footprints: [fp('U1', IC), fp('C1', PASSIVE), fp('C2', PASSIVE), fp('R1', PASSIVE)],
      nets: [
        { name: 'VCC', pins: [{ ref: 'U1', pad: '8' }, { ref: 'C1', pad: '1' }] },
        { name: 'SIG', pins: [{ ref: 'U1', pad: '1' }, { ref: 'C2', pad: '1' }] },
      ],
    };
    const order = connectivityOrder(board).map((f) => f.ref);
    // U1 is the seed (degree 2). Both decoupling caps follow before the isolated R1.
    expect(order[0]).toBe('U1');
    expect(order.slice(0, 3)).toContain('C1');
    expect(order.slice(0, 3)).toContain('C2');
    expect(order[3]).toBe('R1');
  });

  it('weights a 2-pin signal net above a global power star (inverse fanout)', () => {
    const board: BoardModel = {
      width: 0,
      height: 0,
      footprints: [fp('U1', IC), fp('C1', PASSIVE), fp('R1', PASSIVE), fp('R2', PASSIVE)],
      nets: [
        // A dedicated 2-pin net → weight 1 between U1 and C1.
        { name: 'SIG', pins: [{ ref: 'U1', pad: '1' }, { ref: 'C1', pad: '1' }] },
        // A 4-pin star → weight 1/3 between every pair, far weaker than SIG.
        {
          name: 'GND',
          pins: [
            { ref: 'U1', pad: '2' },
            { ref: 'C1', pad: '2' },
            { ref: 'R1', pad: '1' },
            { ref: 'R2', pad: '1' },
          ],
        },
      ],
    };
    const order = connectivityOrder(board).map((f) => f.ref);
    // C1 (the dedicated signal neighbour) must come right after U1, not R1/R2.
    expect(order[0]).toBe('U1');
    expect(order[1]).toBe('C1');
  });

  it('is deterministic for the same netlist', () => {
    const board: BoardModel = {
      width: 0,
      height: 0,
      footprints: [fp('U1', IC), fp('C1', PASSIVE), fp('R1', PASSIVE)],
      nets: [
        { name: 'A', pins: [{ ref: 'U1', pad: '1' }, { ref: 'C1', pad: '1' }] },
        { name: 'B', pins: [{ ref: 'U1', pad: '2' }, { ref: 'R1', pad: '1' }] },
      ],
    };
    expect(connectivityOrder(board)).toEqual(connectivityOrder(board));
  });

  it('falls back to area-descending order when there is no connectivity', () => {
    const board: BoardModel = {
      width: 0,
      height: 0,
      footprints: [fp('C1', PASSIVE), fp('U1', IC), fp('R1', PASSIVE)],
      nets: [],
    };
    const order = connectivityOrder(board).map((f) => f.ref);
    // No nets → pure area-descending: the largest (U1) first, then C1/R1 by ref.
    expect(order[0]).toBe('U1');
    expect(order.slice(1).sort()).toEqual(['C1', 'R1']);
  });

  it('placeBoard packs the connectivity order without overlap and inside bounds', () => {
    const board: BoardModel = {
      width: 0,
      height: 0,
      footprints: [fp('U1', IC), fp('C1', PASSIVE), fp('C2', PASSIVE), fp('R1', PASSIVE), fp('R2', PASSIVE)],
      nets: [
        { name: 'VCC', pins: [{ ref: 'U1', pad: '8' }, { ref: 'C1', pad: '1' }, { ref: 'C2', pad: '1' }] },
        { name: 'SIG', pins: [{ ref: 'U1', pad: '1' }, { ref: 'R1', pad: '1' }, { ref: 'R2', pad: '1' }] },
      ],
    };
    placeBoard(board);
    const abs = (f: PlacedFootprint) => {
      const c = f.courtyard!;
      return { minX: f.x + c.minX, minY: f.y + c.minY, maxX: f.x + c.maxX, maxY: f.y + c.maxY };
    };
    for (const f of board.footprints) {
      const e = abs(f);
      expect(e.minX).toBeGreaterThanOrEqual(0);
      expect(e.minY).toBeGreaterThanOrEqual(0);
      expect(e.maxX).toBeLessThanOrEqual(board.width);
      expect(e.maxY).toBeLessThanOrEqual(board.height);
    }
    for (let i = 0; i < board.footprints.length; i++) {
      for (let j = i + 1; j < board.footprints.length; j++) {
        const a = abs(board.footprints[i]!);
        const b = abs(board.footprints[j]!);
        const overlap = a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
        expect(overlap, `${board.footprints[i]!.ref} vs ${board.footprints[j]!.ref}`).toBe(false);
      }
    }
  });
});

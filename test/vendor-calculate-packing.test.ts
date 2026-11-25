/**
 * The vendored tscircuit calculate-packing engine behind its facade
 * (add-reuse-placer, spec "Vendored geometry engine"): determinism, exact
 * boundary containment (P2), weighted network distance (P3), no silent
 * fallback with failure detail (P4, P5), and basic legality.
 */
import { describe, it, expect } from 'vitest';
import {
  packComponents,
  type FacadeComponent,
  type FacadeInput,
  type FacadePlacement,
} from '../src/vendor/calculate-packing/facade.js';

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The courtyard box of a placed component, in board coordinates. */
function placedBox(component: FacadeComponent, placement: FacadePlacement): Box {
  const rotation = ((placement.rotation % 360) + 360) % 360;
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const offsetX = component.box.x * cos - component.box.y * sin;
  const offsetY = component.box.x * sin + component.box.y * cos;
  const swap = rotation === 90 || rotation === 270;
  const width = swap ? component.box.h : component.box.w;
  const height = swap ? component.box.w : component.box.h;
  const centreX = placement.x + offsetX;
  const centreY = placement.y + offsetY;
  return {
    minX: centreX - width / 2,
    maxX: centreX + width / 2,
    minY: centreY - height / 2,
    maxY: centreY + height / 2,
  };
}

/** Exact gap between two axis-aligned boxes; 0 when they touch or overlap. */
function gapBetween(a: Box, b: Box): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  return Math.hypot(dx, dy);
}

function boxesIntersect(a: Box, b: Box, eps = 1e-9): boolean {
  return a.minX < b.maxX - eps && b.minX < a.maxX - eps && a.minY < b.maxY - eps && b.minY < a.maxY - eps;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ten components with a fixed seed, on a 60 x 40 mm board. */
function seededInput(seed = 20260916): FacadeInput {
  const random = mulberry32(seed);
  const networks = ['VCC', 'GND', 'N1', 'N2', 'N3'];
  const pick = () => networks[Math.floor(random() * networks.length)]!;
  const components: FacadeComponent[] = [];
  for (let i = 0; i < 10; i++) {
    const w = 2 + Math.floor(random() * 5);
    const h = 1 + Math.floor(random() * 3);
    components.push({
      id: `C${i}`,
      box: { x: 0, y: 0, w, h },
      rotations: [0, 90],
      pads: [
        { id: '1', network: pick(), x: -w / 4, y: 0, w: 0.6, h: 0.6 },
        { id: '2', network: pick(), x: w / 4, y: 0, w: 0.6, h: 0.6 },
      ],
    });
  }
  return {
    components,
    obstacles: [],
    boundary: [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
      { x: 0, y: 40 },
    ],
    minGap: 0.5,
  };
}

describe('vendored calculate-packing facade', () => {
  it('is deterministic: the same input gives identical output', () => {
    const first = packComponents(seededInput());
    const second = packComponents(seededInput());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.placements.length + first.unplaced.length).toBe(10);
  });

  it('keeps minGap between every pair of placed boxes and stays inside the board', () => {
    const input = seededInput();
    const result = packComponents(input);
    const byId = new Map(input.components.map((c) => [c.id, c]));

    expect(result.unplaced, JSON.stringify(result.unplaced, null, 1)).toEqual([]);
    expect(result.placements.length).toBe(10);

    const boxes = result.placements.map((p) => ({ id: p.id, box: placedBox(byId.get(p.id)!, p) }));
    for (const { id, box } of boxes) {
      expect(box.minX, id).toBeGreaterThanOrEqual(-1e-6);
      expect(box.minY, id).toBeGreaterThanOrEqual(-1e-6);
      expect(box.maxX, id).toBeLessThanOrEqual(60 + 1e-6);
      expect(box.maxY, id).toBeLessThanOrEqual(40 + 1e-6);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect(gapBetween(a.box, b.box), `${a.id} vs ${b.id}`).toBeGreaterThanOrEqual(input.minGap - 1e-6);
      }
    }
  });

  it('P2: does not place a component across the notch of a U-shaped boundary', () => {
    // A U: the slot x in [12, 18], y in [6, 20] is outside the board.
    const boundary = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 20 },
      { x: 18, y: 20 },
      { x: 18, y: 6 },
      { x: 12, y: 6 },
      { x: 12, y: 20 },
      { x: 0, y: 20 },
    ];
    const notch: Box = { minX: 12, minY: 6, maxX: 18, maxY: 20 };

    // Straddling the notch at (15, 10) puts all four box corners and both pad
    // centres inside the outline, which is exactly what upstream tested.
    const straddler: FacadeComponent = {
      id: 'straddler',
      box: { x: 0, y: 0, w: 14, h: 4 },
      rotations: [0],
      pads: [
        { id: 'L', network: 'NL', x: -6, y: 0, w: 1, h: 1 },
        { id: 'R', network: 'NR', x: 6, y: 0, w: 1, h: 1 },
      ],
    };
    const input: FacadeInput = {
      components: [
        {
          id: 'left-anchor',
          box: { x: 0, y: 0, w: 2, h: 2 },
          rotations: [0],
          pads: [{ id: '1', network: 'NL', x: 0, y: 0, w: 1, h: 1 }],
          fixed: { x: 5, y: 16, rotation: 0 },
        },
        {
          id: 'right-anchor',
          box: { x: 0, y: 0, w: 2, h: 2 },
          rotations: [0],
          pads: [{ id: '1', network: 'NR', x: 0, y: 0, w: 1, h: 1 }],
          fixed: { x: 25, y: 16, rotation: 0 },
        },
        straddler,
      ],
      obstacles: [],
      boundary,
      minGap: 0.4,
    };

    const result = packComponents(input);
    const placement = result.placements.find((p) => p.id === 'straddler');
    if (placement) {
      const box = placedBox(straddler, placement);
      expect(boxesIntersect(box, notch), `straddler box ${JSON.stringify(box)} crosses the notch`).toBe(false);
      expect(box.minX).toBeGreaterThanOrEqual(-1e-6);
      expect(box.maxX).toBeLessThanOrEqual(30 + 1e-6);
      expect(box.maxY).toBeLessThanOrEqual(20 + 1e-6);
    } else {
      // Refusing the position is also correct; it must be reported.
      expect(result.unplaced.map((u) => u.id)).toContain('straddler');
    }
  });

  it('P3: network weights pull a component towards the heavier partner', () => {
    const mover: FacadeComponent = {
      id: 'mover',
      box: { x: 0, y: 0, w: 2, h: 1 },
      rotations: [0],
      pads: [
        { id: 'a', network: 'NA', x: -0.5, y: 0, w: 0.5, h: 0.5 },
        { id: 'b', network: 'NB', x: 0.5, y: 0, w: 0.5, h: 0.5 },
      ],
    };
    const base: FacadeInput = {
      components: [
        {
          id: 'left',
          box: { x: 0, y: 0, w: 2, h: 2 },
          rotations: [0],
          pads: [{ id: '1', network: 'NA', x: 0, y: 0, w: 0.5, h: 0.5 }],
          fixed: { x: -10, y: 0, rotation: 0 },
        },
        {
          id: 'right',
          box: { x: 0, y: 0, w: 2, h: 2 },
          rotations: [0],
          pads: [{ id: '1', network: 'NB', x: 0, y: 0, w: 0.5, h: 0.5 }],
          fixed: { x: 10, y: 0, rotation: 0 },
        },
        mover,
      ],
      obstacles: [],
      boundary: [
        { x: -15, y: -8 },
        { x: 15, y: -8 },
        { x: 15, y: 8 },
        { x: -15, y: 8 },
      ],
      minGap: 0.3,
    };

    const towardsLeft = packComponents({ ...base, networkWeights: { NA: 6, NB: 1 } });
    const towardsRight = packComponents({ ...base, networkWeights: { NA: 1, NB: 6 } });

    const left = towardsLeft.placements.find((p) => p.id === 'mover');
    const right = towardsRight.placements.find((p) => p.id === 'mover');
    expect(left, JSON.stringify(towardsLeft.unplaced)).toBeDefined();
    expect(right, JSON.stringify(towardsRight.unplaced)).toBeDefined();
    expect(left!.x).toBeLessThan(0);
    expect(right!.x).toBeGreaterThan(0);
    // The two cases are mirror images of each other.
    expect(Math.abs(left!.x + right!.x)).toBeLessThan(1e-6);
  });

  it('P4/P5: a component that cannot fit is reported, and the others are still packed', () => {
    const boundary = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 20 },
      { x: 0, y: 20 },
    ];
    const tooBig: FacadeComponent = {
      id: 'too-big',
      box: { x: 0, y: 0, w: 100, h: 100 },
      rotations: [0, 90],
      pads: [{ id: '1', network: 'N1', x: 0, y: 0, w: 1, h: 1 }],
    };
    const small: FacadeComponent = {
      id: 'small',
      box: { x: 0, y: 0, w: 3, h: 2 },
      rotations: [0, 90],
      pads: [{ id: '1', network: 'N1', x: 0, y: 0, w: 0.6, h: 0.6 }],
    };

    // (a) the oversized part is packed first, so it takes the first-component path
    const first = packComponents({
      components: [tooBig, small],
      obstacles: [],
      boundary,
      minGap: 0.4,
      order: ['too-big'],
    });
    // (b) a fixed part is already placed, so it takes the sub-solver path
    const second = packComponents({
      components: [
        {
          id: 'anchor',
          box: { x: 0, y: 0, w: 2, h: 2 },
          rotations: [0],
          pads: [{ id: '1', network: 'N1', x: 0, y: 0, w: 0.6, h: 0.6 }],
          fixed: { x: 15, y: 10, rotation: 0 },
        },
        tooBig,
        small,
      ],
      obstacles: [],
      boundary,
      minGap: 0.4,
    });

    for (const [label, result] of [
      ['first component', first],
      ['after a fixed component', second],
    ] as const) {
      expect(result.placements.map((p) => p.id), label).toContain('small');
      const unplaced = result.unplaced.find((u) => u.id === 'too-big');
      expect(unplaced, `${label}: too-big should be reported unplaced`).toBeDefined();
      expect(unplaced!.rotationsTried.length, label).toBeGreaterThan(0);
      expect(['bounds', 'boundary'], label).toContain(unplaced!.closestRejection);
      expect(unplaced!.message, label).toMatch(/larger than/);
      expect(result.iterations, label).toBeGreaterThan(0);
    }
  });

  it('reports every component exactly once, as placed or unplaced', () => {
    const input = seededInput(7);
    input.components.push({
      id: 'impossible',
      box: { x: 0, y: 0, w: 500, h: 500 },
      rotations: [0],
      pads: [{ id: '1', network: 'VCC', x: 0, y: 0, w: 1, h: 1 }],
    });
    const result = packComponents(input);
    const reported = [...result.placements.map((p) => p.id), ...result.unplaced.map((u) => u.id)].sort();
    expect(reported).toEqual(input.components.map((c) => c.id).sort());
    expect(result.unplaced.map((u) => u.id)).toContain('impossible');
  });
});

/**
 * placer-blocks, brick 1: every part goes inside the region its subsystem was
 * given, or it is reported unplaced. That is the whole contract for this brick,
 * so the tests are about containment and honesty, nothing else.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlocksPlacer, occupancy, type RegionConstraint } from '../src/pcb/engines/placers/blocks/adapter.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { makeSnapshot, DEFAULT_LIMITS } from '../src/pcb/ir/snapshot.js';
import { applyPlacements } from '../src/pcb/ir/transform.js';
import { bbox } from '../src/pcb/ir/geometry.js';
import type { PlacementJob } from '../src/pcb/engines/contracts.js';
import type { BBox } from '../src/pcb/ir/geometry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'microboards');

async function design(name: string) {
  const p = path.join(GOLDEN, name, 'board.kicad_pcb');
  return importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, now: 't' }).design;
}

function job(d: Awaited<ReturnType<typeof design>>, constraints: unknown[]): PlacementJob {
  const movable = d.components.filter((c) => !c.attributes.locked).map((c) => c.id);
  const snapshot = makeSnapshot(d, { kind: 'placement', movableComponentIds: movable }, { seed: 0, limits: DEFAULT_LIMITS });
  return { runId: 't', snapshot, movableComponentIds: movable, constraints, objectives: [], seed: 0, limits: snapshot.limits };
}

const inside = (e: BBox, r: BBox) => e.minX >= r.minX - 1 && e.maxX <= r.maxX + 1 && e.minY >= r.minY - 1 && e.maxY <= r.maxY + 1;
const ctx = { workDir: '/tmp', boardPath: '', log: () => {} };

describe('placer-blocks (brick 1: containment)', () => {
  it('puts every member inside the region its subsystem was given', async () => {
    const d = await design('completion');
    const ob = bbox(d.board.outline);
    const refs = d.components.map((c) => c.reference);
    // one region over the left half of the board, holding every part
    const bounds: BBox = { minX: ob.minX, maxX: (ob.minX + ob.maxX) / 2, minY: ob.minY, maxY: ob.maxY };
    const region: RegionConstraint = { kind: 'functional.region', id: 'all', refs, bounds };

    const res = await new BlocksPlacer().place(job(d, [region]), ctx);
    expect(res.placements.length).toBeGreaterThan(0);
    expect(res.unplacedComponentIds).toEqual([]);

    const out = applyPlacements(d, res.placements);
    for (const c of out.components) {
      if (!res.placements.some((p) => p.id === c.id)) continue;
      expect(inside(occupancy(c), bounds), `${c.reference} outside its region`).toBe(true);
    }
  });

  it('places parts of one region without landing them on each other', async () => {
    const d = await design('completion');
    const ob = bbox(d.board.outline);
    const bounds: BBox = { minX: ob.minX, maxX: ob.maxX, minY: ob.minY, maxY: ob.maxY };
    const region: RegionConstraint = { kind: 'functional.region', id: 'all', refs: d.components.map((c) => c.reference), bounds };
    const res = await new BlocksPlacer().place(job(d, [region]), ctx);
    const out = applyPlacements(d, res.placements);
    const boxes = out.components.filter((c) => res.placements.some((p) => p.id === c.id)).map((c) => ({ ref: c.reference, e: occupancy(c) }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!.e, b = boxes[j]!.e;
        const hit = a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
        expect(hit, `${boxes[i]!.ref} overlaps ${boxes[j]!.ref}`).toBe(false);
      }
    }
  });

  it('reports a part too large for its region rather than placing it anyway', async () => {
    const d = await design('completion');
    const ob = bbox(d.board.outline);
    // a sliver no footprint fits in
    const bounds: BBox = { minX: ob.minX, maxX: ob.minX + 200_000, minY: ob.minY, maxY: ob.minY + 200_000 };
    const region: RegionConstraint = { kind: 'functional.region', id: 'tiny', refs: d.components.map((c) => c.reference), bounds };
    const res = await new BlocksPlacer().place(job(d, [region]), ctx);
    expect(res.placements).toEqual([]);
    expect(res.unplacedComponentIds.length).toBe(d.components.filter((c) => !c.attributes.locked).length);
    expect(res.status).toBe('partial');
  });

  it('leaves a part in no region where it is', async () => {
    const d = await design('completion');
    const res = await new BlocksPlacer().place(job(d, []), ctx);
    expect(res.placements).toEqual([]);
    expect(res.status).toBe('complete');
  });

  it('charges a part by its pads and body, never its fused courtyard', async () => {
    const d = await design('completion');
    for (const c of d.components) {
      if (!c.footprint.courtyard || !c.pads.length) continue;
      const o = occupancy(c), cy = bbox(c.footprint.courtyard);
      expect(o.maxX - o.minX).toBeLessThanOrEqual(cy.maxX - cy.minX + 1);
      expect(o.maxY - o.minY).toBeLessThanOrEqual(cy.maxY - cy.minY + 1);
    }
  });
});

/**
 * placer-reference (harnessOnly): the shelf pack that populates boards in
 * `src/kicad/board.ts`, run over the IR so the harness has a deterministic
 * placer that always produces a legal (if naive) candidate. Movable parts are
 * packed in rows inside the outline, skipping the fixed parts' courtyards.
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { ComponentInstance } from '../../../ir/types.js';
import { bbox, bboxOf, type Polygon } from '../../../ir/geometry.js';
import { movable, resultShape } from '../shared.js';
import type { PlacedComponent } from '../../../ir/types.js';

export const REFERENCE_PLACER_MANIFEST: EngineManifest = {
  id: 'placer-reference',
  kind: 'placer',
  version: '1',
  adapterVersion: '1',
  license: 'Apache-2.0',
  inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  determinism: 'deterministic',
  executionMode: 'library',
  networkRequirement: 'none',
  harnessOnly: true,
  requires: {},
  capabilities: { bottomSide: false, rotation: false, arbitraryOutline: false, relativeConstraints: [], fixedComponents: true, congestionAwareness: false, layoutReuse: false },
  supportedConstraints: [],
};

/** A part's footprint extent: its courtyard, else its pads. */
function extent(c: ComponentInstance): { minX: number; minY: number; maxX: number; maxY: number } {
  const polys: Polygon[] = c.footprint.courtyard ? [c.footprint.courtyard] : c.pads.map((p) => p.copper);
  return polys.length ? bboxOf(polys) : { minX: c.at.x, minY: c.at.y, maxX: c.at.x, maxY: c.at.y };
}

const overlaps = (a: { minX: number; minY: number; maxX: number; maxY: number }, b: { minX: number; minY: number; maxX: number; maxY: number }): boolean => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

export class ReferencePlacer implements PlacerPlugin {
  constructor(private readonly opts: { gapNm?: number; marginNm?: number } = {}) {}
  async manifest(): Promise<EngineManifest> {
    return REFERENCE_PLACER_MANIFEST;
  }
  async place(job: PlacementJob, _ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const started = new Date(t0).toISOString();
    const design = job.snapshot.design;
    const gap = this.opts.gapNm ?? 1_000_000;
    const margin = this.opts.marginNm ?? Math.max(gap, design.board.rules.copperEdgeClearanceNm + 500_000);
    const board = bbox(design.board.outline);
    const moving = movable(job);
    const movingIds = new Set(moving.map((c) => c.id));
    const fixedBoxes = design.components.filter((c) => !movingIds.has(c.id)).map(extent);
    // largest first packs tighter; ties by refdes keep it deterministic
    const order = [...moving].sort((a, b) => {
      const ea = extent(a), eb = extent(b);
      return (eb.maxX - eb.minX) * (eb.maxY - eb.minY) - (ea.maxX - ea.minX) * (ea.maxY - ea.minY) || a.reference.localeCompare(b.reference);
    });
    const placements: PlacedComponent[] = [];
    const unplaced: string[] = [];
    const placedBoxes: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
    let x = board.minX + margin;
    let y = board.minY + margin;
    let rowH = 0;
    for (const c of order) {
      const e = extent(c);
      const w = e.maxX - e.minX, h = e.maxY - e.minY;
      // the part's extent relative to its origin (rotation stays as is)
      const dx = c.at.x - e.minX, dy = c.at.y - e.minY;
      let placed = false;
      for (let tries = 0; tries < 10_000 && !placed; tries++) {
        if (x + w + margin > board.maxX) {
          x = board.minX + margin;
          y += rowH + gap;
          rowH = 0;
        }
        if (y + h + margin > board.maxY) break;
        const box = { minX: x, minY: y, maxX: x + w, maxY: y + h };
        const hit = [...fixedBoxes, ...placedBoxes].find((b) => overlaps({ minX: box.minX - gap, minY: box.minY - gap, maxX: box.maxX + gap, maxY: box.maxY + gap }, b));
        if (hit) {
          x = hit.maxX + gap;
          continue;
        }
        placements.push({ id: c.id, at: { x: x + dx, y: y + dy }, rotation: c.rotation, side: c.attributes.side });
        placedBoxes.push(box);
        x += w + gap;
        rowH = Math.max(rowH, h);
        placed = true;
      }
      if (!placed) unplaced.push(c.id);
    }
    return resultShape(unplaced.length ? (placements.length ? 'partial' : 'failed') : 'complete', placements, unplaced, (Date.now() - t0) / 1000, { engineId: REFERENCE_PLACER_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: started, finishedAt: new Date().toISOString() });
  }
}

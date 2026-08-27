/**
 * Deterministic in-repo placement (issue #252): an area-descending grid/shelf
 * packer. It knows nothing about connectivity — a decoupling cap can land far
 * from its IC — which is exactly the "grid, not a layout" fallback the issue
 * names. A connectivity-aware placer is the follow-up (#141 generation half).
 */

import type { BoardModel, Extents, Placement, PlacementConstraints, PlacementEngine, PlacedFootprint } from './types.js';

export const DEFAULT_PLACE_GAP_MM = 1.5;
export const DEFAULT_PLACE_MARGIN_MM = 1.0;

/** Footprint bounding box relative to its origin: courtyard when present, else
 * the pad extents (copper). */
export function footprintExtents(fp: PlacedFootprint): Extents {
  if (fp.courtyard) return fp.courtyard;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of fp.pads) {
    minX = Math.min(minX, p.x - p.width / 2);
    maxX = Math.max(maxX, p.x + p.width / 2);
    minY = Math.min(minY, p.y - p.height / 2);
    maxY = Math.max(maxY, p.y + p.height / 2);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/** Footprint bounding-box size (mm). */
export function footprintSize(fp: PlacedFootprint): { width: number; height: number } {
  const e = footprintExtents(fp);
  return { width: e.maxX - e.minX, height: e.maxY - e.minY };
}

/**
 * Deterministic grid placement over a whole board: order area-descending
 * (tie-break by ref), pack left-to-right wrapping at a row width derived from
 * total area, then size the board to the placed courtyard bounding box. The
 * footprint origin is offset by the courtyard `minX`/`minY`, so copper always
 * lands inside the board edge (no copper-edge-clearance violation). Mutates
 * `board` footprints (`x`/`y`) and `board.width`/`height`.
 */
export function placeBoard(board: BoardModel, opts: { gap?: number; margin?: number } = {}): void {
  const gap = opts.gap ?? DEFAULT_PLACE_GAP_MM;
  const margin = opts.margin ?? DEFAULT_PLACE_MARGIN_MM;

  const ordered = [...board.footprints].sort((a, b) => {
    const sa = footprintSize(a);
    const sb = footprintSize(b);
    const area = sb.width * sb.height - sa.width * sa.height;
    return area !== 0 ? area : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });

  const totalArea = ordered.reduce((a, fp) => a + footprintSize(fp).width * footprintSize(fp).height, 0);
  const rowW = Math.max(25, Math.min(150, Math.sqrt(totalArea) * 2.5));

  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const fp of ordered) {
    const e = footprintExtents(fp);
    const w = e.maxX - e.minX;
    const h = e.maxY - e.minY;
    if (cx > 0 && cx + w > rowW) {
      cx = 0;
      cy += rowH + gap;
      rowH = 0;
    }
    fp.x = margin + cx - e.minX;
    fp.y = margin + cy - e.minY;
    cx += w + gap;
    rowH = Math.max(rowH, h);
  }

  let maxX = 0;
  let maxY = 0;
  for (const fp of board.footprints) {
    const e = footprintExtents(fp);
    maxX = Math.max(maxX, fp.x + e.maxX);
    maxY = Math.max(maxY, fp.y + e.maxY);
  }
  board.width = maxX + margin;
  board.height = maxY + margin;
}

/**
 * The first `PlacementEngine` — a deterministic area-descending grid packer. It
 * delegates to {@link placeBoard}; the class exists so the engine boundary has a
 * concrete in-repo implementation to test against.
 */
export class GridPlacementEngine implements PlacementEngine {
  async place(board: BoardModel, _constraints: PlacementConstraints): Promise<Placement> {
    placeBoard(board);
    return { footprints: board.footprints };
  }
}

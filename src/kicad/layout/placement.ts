/**
 * Deterministic in-repo placement default (issue #252): an area-descending
 * shelf/grid packer. It knows nothing about connectivity — a decoupling cap can
 * land far from its IC — which is exactly the "grid, not a layout" fallback the
 * issue names. It exists so the `PlacementEngine` boundary has a concrete,
 * deterministic implementation to test against; a connectivity-aware placer is
 * the follow-up (#141).
 */

import type { BoardModel, Netlist, Placement, PlacementConstraints, PlacementEngine, PlacedFootprint } from './types.js';

export const DEFAULT_PLACE_GAP_MM = 1.5;
export const DEFAULT_PLACE_MARGIN_MM = 1.0;

/** Footprint bounding-box size (mm): courtyard when present, else the pad extents. */
export function footprintSize(fp: PlacedFootprint): { width: number; height: number } {
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
  if (!Number.isFinite(minX)) return { width: 1, height: 1 };
  return { width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

/**
 * Packs footprints left-to-right, wrapping into rows, largest courtyard first.
 * Deterministic: no randomness, no clock; a tie on area breaks by ref so the
 * same board always packs to the same coordinates. Footprint `x`/`y` is the
 * bounding-box top-left (the grid has no footprint-origin model), which is fine
 * for a draft.
 */
export class GridPlacementEngine implements PlacementEngine {
  constructor(
    private readonly gap: number = DEFAULT_PLACE_GAP_MM,
    private readonly margin: number = DEFAULT_PLACE_MARGIN_MM,
  ) {}

  async place(board: BoardModel, _netlist: Netlist, _constraints: PlacementConstraints): Promise<Placement> {
    const ordered = [...board.footprints].sort((a, b) => {
      const sa = footprintSize(a);
      const sb = footprintSize(b);
      const area = sb.width * sb.height - sa.width * sa.height;
      if (area !== 0) return area;
      return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
    });

    const innerW = Math.max(0, board.width - 2 * this.margin);
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    const placed: PlacedFootprint[] = [];

    for (const fp of ordered) {
      const size = footprintSize(fp);
      if (cursorX > 0 && cursorX + size.width > innerW) {
        cursorX = 0;
        cursorY += rowHeight + this.gap;
        rowHeight = 0;
      }
      placed.push({ ...fp, x: this.margin + cursorX, y: this.margin + cursorY });
      cursorX += size.width + this.gap;
      rowHeight = Math.max(rowHeight, size.height);
    }

    return { footprints: placed };
  }
}

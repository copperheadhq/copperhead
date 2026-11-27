/**
 * Moving parts in the IR (add-reuse-placer): apply placements to a design in
 * memory, geometry and all, so a candidate can be measured without writing a
 * KiCad file first. The exporter remains the only thing that writes copper;
 * this is for screening, where hundreds of candidates are compared and only a
 * few are worth materialising.
 *
 * A pad's position and rotation are absolute in the IR, and its copper, the
 * courtyard and the body are board-coordinate polygons, so every one of them
 * moves with the part.
 */
import type { PcbDesign, PlacedComponent, ComponentInstance, Mdeg, Point } from './types.js';
import type { Polygon } from './geometry.js';
import { placeLocal, rotatePoint, translate } from './geometry.js';
import { normMdeg } from './units.js';

function moveLocal(poly: Polygon, from: Point, to: Point, dRot: Mdeg): Polygon {
  return placeLocal(translate(poly, -from.x, -from.y), to, dRot);
}

/** The component as it would be at `to`, with every polygon it owns moved with it. */
export function moveComponent(c: ComponentInstance, to: PlacedComponent): ComponentInstance {
  const dRot = normMdeg(to.rotation - c.rotation);
  if (dRot === 0 && to.at.x === c.at.x && to.at.y === c.at.y) return c;
  const put = (poly: Polygon) => moveLocal(poly, c.at, to.at, dRot);
  return {
    ...c,
    at: { ...to.at },
    rotation: normMdeg(to.rotation),
    footprint: {
      ...c.footprint,
      courtyard: c.footprint.courtyard ? put(c.footprint.courtyard) : null,
      body: c.footprint.body ? put(c.footprint.body) : null,
    },
    pads: c.pads.map((p) => {
      const local = rotatePoint({ x: p.at.x - c.at.x, y: p.at.y - c.at.y }, dRot);
      return { ...p, at: { x: to.at.x + local.x, y: to.at.y + local.y }, rotation: normMdeg(p.rotation + dRot), copper: put(p.copper) };
    }),
  };
}

/**
 * A copy of the design with the placements applied. A placement that asks for
 * the other side is applied as a move only: flipping a part is the exporter's
 * business and no placer in this release does it.
 */
export function applyPlacements(design: PcbDesign, placements: PlacedComponent[]): PcbDesign {
  if (!placements.length) return design;
  const by = new Map(placements.map((p) => [p.id, p]));
  const components = design.components.map((c) => {
    const p = by.get(c.id);
    return p ? moveComponent(c, { ...p, side: c.attributes.side }) : c;
  });
  // the nets hold pad ids, which do not change when a part moves
  return { ...design, components };
}

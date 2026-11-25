/**
 * Geometry checker (RFC 11 §10.2, implementation spec §5.3): the facts KiCad
 * DRC does not report on its own, computed from the IR alone.
 */
import type { PcbDesign } from '../../ir/types.js';
import { copperStack, isThroughVia } from '../../ir/layers.js';
import { contains, intersects, intersection, area, bbox, bboxOf, bboxOverlap, rectFromBounds } from '../../ir/geometry.js';
import type { Polygon } from '../../ir/geometry.js';
import type { FabricationProfile } from '../profiles/index.js';
import { make, statusOf, type CheckResult, type Diagnostic } from '../diagnostic.js';

export const GEOMETRY_CHECKER = { id: 'copperhead-geometry', version: '1' };

/** The project's own severity for a KiCad rule, when it lowered it (RFC 11 §7.5: ECAD-authored rules outrank ours). */
export function projectSeverity(design: PcbDesign, kicadType: string): { severity: 'error' | 'warning' | 'info' } | Record<string, never> {
  const s = design.board.rules.severities[kicadType];
  if (s === 'warning') return { severity: 'warning' };
  if (s === 'ignore' || s === 'exclusion') return { severity: 'info' };
  return {};
}

/** Bounding box of a footprint's copper, the stand-in for a missing courtyard. */
function padExtent(c: PcbDesign['components'][number]): Polygon | null {
  const pads = c.pads.filter((p) => p.layers.length);
  if (!pads.length) return null;
  const b = bboxOf(pads.map((p) => p.copper));
  return rectFromBounds(b.minX, b.minY, b.maxX, b.maxY);
}

function fullyInside(poly: Polygon, outline: Polygon): boolean {
  return poly.outer.every((p) => contains(outline, p));
}

export function checkGeometry(design: PcbDesign, profile: FabricationProfile): CheckResult {
  const d: Diagnostic[] = [];
  const outline = design.board.outline;
  const stack = copperStack(design);
  const copperLayers = new Set(stack);
  const netName = new Map(design.nets.map((n) => [n.id, n.name]));

  // footprints: outside the outline, inside a cutout, courtyard overlap
  for (const c of design.components) {
    const shape = c.footprint.courtyard ?? padExtent(c);
    if (!shape) continue;
    const copperOut = c.pads.filter((p) => p.layers.length && !fullyInside(p.copper, outline));
    if (copperOut.length) {
      d.push(make(GEOMETRY_CHECKER, 'geom.outside-board', { entityIds: [c.id], entityReferences: [c.reference], region: shape, message: `${c.reference}: ${copperOut.length} pad(s) outside the board outline`, suggestedActions: ['move-group', 'resize-region'] }));
    } else if (!fullyInside(shape, outline)) {
      d.push(make(GEOMETRY_CHECKER, 'geom.overhang', { entityIds: [c.id], entityReferences: [c.reference], region: shape, message: `${c.reference}'s courtyard extends past the board outline (copper is inside)`, suggestedActions: [] }));
    }
    for (const cut of design.board.cutouts) {
      if (intersects(shape, cut)) d.push(make(GEOMETRY_CHECKER, 'geom.in-cutout', { entityIds: [c.id], entityReferences: [c.reference], region: shape, message: `${c.reference} overlaps a board cutout`, suggestedActions: ['move-group'] }));
    }
  }
  // no courtyard drawn: nothing to overlap, as in KiCad's own DRC; pre-flight already warned that overlap cannot be checked for that
  // part, and pad-on-pad collisions are DRC clearance errors regardless. A pad-extent stand-in was tried and refused human boards
  // KiCad passes (PCBench's larger boards: KiCad 4-era one-pad "VIA" footprints under parts, axial resistors end to end).
  const withCourtyard = design.components.map((c) => ({ c, poly: c.footprint.courtyard })).filter((x): x is { c: typeof x.c; poly: Polygon } => !!x.poly);
  for (let i = 0; i < withCourtyard.length; i++) {
    const { c: a, poly: pa } = withCourtyard[i]!;
    const ba = bbox(pa);
    for (let j = i + 1; j < withCourtyard.length; j++) {
      const { c: b, poly: pb } = withCourtyard[j]!;
      if (a.attributes.side !== b.attributes.side) continue;
      if (!bboxOverlap(ba, bbox(pb))) continue;
      const overlap = intersection(pa, pb);
      const ov = overlap.reduce((s, p) => s + area(p), 0);
      if (ov <= 0) continue;
      d.push(make(GEOMETRY_CHECKER, 'geom.courtyard-overlap', {
        ...projectSeverity(design, 'courtyards_overlap'),
        entityIds: [a.id, b.id],
        entityReferences: [a.reference, b.reference],
        ...(overlap[0] ? { region: overlap[0] } : {}),
        measured: { value: Math.round(ov), unit: 'nm2' },
        allowed: { value: 0, unit: 'nm2', relation: '==' },
        message: `courtyards of ${a.reference} and ${b.reference} overlap`,
        suggestedActions: ['move-group', 'rotate-component'],
      }));
    }
  }

  // copper: layers, widths, degenerate records, outside the outline
  for (const s of design.routing.segments) {
    const net = netName.get(s.netId) ?? '?';
    if (!copperLayers.has(s.layer)) d.push(make(GEOMETRY_CHECKER, 'geom.unknown-layer', { entityIds: [s.id], entityReferences: [net], message: `segment on net ${net} references layer "${s.layer}", which the board does not have`, suggestedActions: ['rip-up-nets'] }));
    if (s.a.x === s.b.x && s.a.y === s.b.y) d.push(make(GEOMETRY_CHECKER, 'geom.degenerate', { entityIds: [s.id], entityReferences: [net], message: `zero-length segment on net ${net}`, suggestedActions: ['rip-up-nets'] }));
    if (s.width < profile.minTrackNm) d.push(make(GEOMETRY_CHECKER, 'geom.width', { entityIds: [s.id], entityReferences: [net], measured: { value: s.width, unit: 'nm' }, allowed: { value: profile.minTrackNm, unit: 'nm', relation: '>=' }, message: `segment on net ${net} is narrower than the profile minimum`, suggestedActions: ['tune-router'] }));
    if (!contains(outline, s.a) || !contains(outline, s.b)) d.push(make(GEOMETRY_CHECKER, 'geom.outside-board', { entityIds: [s.id], entityReferences: [net], message: `segment on net ${net} leaves the board outline`, suggestedActions: ['rip-up-nets'] }));
  }
  for (const v of design.routing.vias) {
    const net = netName.get(v.netId) ?? '?';
    if (v.layers[0] === v.layers[1] || !copperLayers.has(v.layers[0]) || !copperLayers.has(v.layers[1])) {
      d.push(make(GEOMETRY_CHECKER, 'geom.via-layers', { entityIds: [v.id], entityReferences: [net], message: `via on net ${net} does not span two copper layers of this board`, suggestedActions: ['rip-up-nets'] }));
    } else if (!isThroughVia(v, stack)) {
      // blind and buried vias wait on a profile and an engine that declare them (add-multilayer-layout D2)
      d.push(make(GEOMETRY_CHECKER, 'geom.via-layers', { entityIds: [v.id], entityReferences: [net], message: `via on net ${net} spans ${v.layers[0]} to ${v.layers[1]}; only through vias (${stack[0]} to ${stack[stack.length - 1]}) are supported`, suggestedActions: ['rip-up-nets'] }));
    }
    if (v.size <= 0 || v.drill <= 0) d.push(make(GEOMETRY_CHECKER, 'geom.degenerate', { entityIds: [v.id], entityReferences: [net], message: `via on net ${net} has no size or drill`, suggestedActions: ['rip-up-nets'] }));
    if (!contains(outline, v.at)) d.push(make(GEOMETRY_CHECKER, 'geom.outside-board', { entityIds: [v.id], entityReferences: [net], message: `via on net ${net} lies outside the board outline`, suggestedActions: ['rip-up-nets'] }));
  }
  return { checker: GEOMETRY_CHECKER, status: statusOf(d), diagnostics: d, metrics: { courtyard_overlaps: d.filter((x) => x.code === 'geom.courtyard-overlap').length }, evidence: [] };
}

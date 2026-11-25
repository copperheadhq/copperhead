/**
 * Transfer (add-reuse-placer, RFC 14 §7.3): put the reference's placement into
 * the target board's frame. One rigid transform for the whole board —
 * translation plus a rotation of a multiple of 90°, never a scale, never a
 * mirror — chosen by what the target already fixes:
 *
 * - two or more fixed anchors (connectors, mounting holes, user-fixed parts):
 *   the transform that fits their reference counterparts best
 * - one anchor: the rotation, of the four, that puts the fewest parts outside
 *   the outline once that anchor coincides
 * - none: the reference's placed extent centred on the target's outline, in
 *   the rotation that fits the outline best
 *
 * The result is a starting placement, not a legal one: parts that land outside
 * the outline or on top of each other are named here and fixed by the packer.
 */
import type { PcbDesign, ComponentInstance, PlacedComponent, Point, Mdeg } from '../../ir/types.js';
import type { Polygon } from '../../ir/geometry.js';
import { bbox, bboxOf, contains, placeLocal, rectFromBounds, rotatePoint, translate } from '../../ir/geometry.js';
import { normMdeg } from '../../ir/units.js';
import type { Match } from './match.js';
import { partExtent } from './match.js';

export interface Transform {
  rotationMdeg: Mdeg;
  dx: number;
  dy: number;
}

export interface TransferResult {
  transform: Transform;
  /** Where each matched, movable part would sit. */
  placements: PlacedComponent[];
  /** Mean distance between a fitted anchor and where the transform puts it; 0 when no anchors were fitted. */
  residualNm: number;
  fittedOn: 'anchors' | 'anchor' | 'outline';
  anchorRefs: string[];
  /** Matched parts whose transferred extent leaves the outline. */
  outsideOutline: string[];
  /** Matched parts whose transferred extents overlap, as reference pairs. */
  overlapping: [string, string][];
  skipped: { ref: string; why: string }[];
}

export const ROTATIONS: Mdeg[] = [0, 90_000, 180_000, 270_000];

export function applyTransform(p: Point, t: Transform): Point {
  const r = rotatePoint(p, t.rotationMdeg);
  return { x: Math.round(r.x + t.dx), y: Math.round(r.y + t.dy) };
}

/** The transform of each rotation that best fits the pairs, and the mean residual of the best. */
export function fitTransform(pairs: { from: Point; to: Point }[]): { transform: Transform; residualNm: number } {
  let best: { transform: Transform; residualNm: number } | null = null;
  for (const rotationMdeg of ROTATIONS) {
    const rotated = pairs.map((p) => rotatePoint(p.from, rotationMdeg));
    const dx = pairs.reduce((a, p, i) => a + (p.to.x - rotated[i]!.x), 0) / pairs.length;
    const dy = pairs.reduce((a, p, i) => a + (p.to.y - rotated[i]!.y), 0) / pairs.length;
    const residual = pairs.reduce((a, p, i) => a + Math.hypot(p.to.x - (rotated[i]!.x + dx), p.to.y - (rotated[i]!.y + dy)), 0) / pairs.length;
    if (!best || residual < best.residualNm - 1) best = { transform: { rotationMdeg, dx: Math.round(dx), dy: Math.round(dy) }, residualNm: Math.round(residual) };
  }
  return best!;
}

/**
 * The part's courtyard (its copper extent when it draws none) as it would sit
 * at `at` with `rotation`. Overlap is judged on this polygon, not on a
 * bounding box: a box around a rotated or L-shaped courtyard reports overlaps
 * that KiCad's own check does not.
 */
export function poseOutline(c: ComponentInstance, at: Point, rotation: Mdeg): Polygon {
  const source = c.footprint.courtyard ?? (c.pads.length ? rectFromBounds(partExtent(c).minX, partExtent(c).minY, partExtent(c).maxX, partExtent(c).maxY) : rectFromBounds(c.at.x, c.at.y, c.at.x, c.at.y));
  const local = translate(source, -c.at.x, -c.at.y);
  return placeLocal(local, at, normMdeg(rotation - c.rotation));
}

/** A part's extent if it were placed at `at` with `rotation`, in board coordinates. */
export function extentAt(c: ComponentInstance, at: Point, rotation: Mdeg): { minX: number; minY: number; maxX: number; maxY: number } {
  return bbox(poseOutline(c, at, rotation));
}

const boxOverlap = (a: ReturnType<typeof extentAt>, b: ReturnType<typeof extentAt>) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

export interface TransferOptions {
  /** Component ids the target may move; others keep their positions and act as anchors. */
  movableIds?: Set<string>;
  /** Extra target component ids to fit on, beside locked and immovable parts. */
  anchorIds?: Set<string>;
}

export function transferPlacement(target: PcbDesign, reference: PcbDesign, matches: Match[], opts: TransferOptions = {}): TransferResult {
  const tById = new Map(target.components.map((c) => [c.id, c]));
  const rById = new Map(reference.components.map((c) => [c.id, c]));
  const movable = opts.movableIds ?? new Set(target.components.filter((c) => !c.attributes.locked).map((c) => c.id));
  const pairs = matches.map((m) => ({ m, t: tById.get(m.targetId), r: rById.get(m.referenceId) })).filter((p): p is { m: Match; t: ComponentInstance; r: ComponentInstance } => !!p.t && !!p.r);

  const anchors = pairs.filter(({ m, t }) => t.attributes.locked || !movable.has(t.id) || opts.anchorIds?.has(t.id) || opts.anchorIds?.has(m.targetRef));
  let fit: { transform: Transform; residualNm: number };
  let fittedOn: TransferResult['fittedOn'];
  const outline = bbox(target.board.outline);
  const placedRef = pairs.length ? bboxOf(pairs.map(({ r }) => {
    const e = partExtent(r);
    return { outer: [{ x: e.minX, y: e.minY }, { x: e.maxX, y: e.minY }, { x: e.maxX, y: e.maxY }, { x: e.minX, y: e.maxY }], holes: [] };
  })) : outline;

  const outsideCount = (t: Transform) => pairs.reduce((a, { t: tc, r }) => {
    const at = applyTransform(r.at, t);
    const e = extentAt(tc, at, normMdeg(r.rotation + t.rotationMdeg));
    const corners: Point[] = [{ x: e.minX, y: e.minY }, { x: e.maxX, y: e.minY }, { x: e.maxX, y: e.maxY }, { x: e.minX, y: e.maxY }];
    return a + (corners.every((p) => contains(target.board.outline, p)) ? 0 : 1);
  }, 0);

  if (anchors.length >= 2) {
    fit = fitTransform(anchors.map(({ t, r }) => ({ from: r.at, to: t.at })));
    fittedOn = 'anchors';
  } else if (anchors.length === 1) {
    const a = anchors[0]!;
    const candidates = ROTATIONS.map((rotationMdeg) => {
      const rot = rotatePoint(a.r.at, rotationMdeg);
      return { rotationMdeg, dx: Math.round(a.t.at.x - rot.x), dy: Math.round(a.t.at.y - rot.y) };
    });
    const best = candidates.map((t) => ({ t, out: outsideCount(t) })).sort((x, y) => x.out - y.out || x.t.rotationMdeg - y.t.rotationMdeg)[0]!;
    fit = { transform: best.t, residualNm: 0 };
    fittedOn = 'anchor';
  } else {
    // centre the reference board on this one, not the reference's parts: the parts'
    // positions are meaningful relative to their outline, and when the two outlines
    // are the same shape this is the identity, which is what reuse should give
    const refOutline = bbox(reference.board.outline);
    const degenerate = refOutline.maxX <= refOutline.minX || refOutline.maxY <= refOutline.minY;
    const from = degenerate ? placedRef : refOutline;
    const centre = { x: (outline.minX + outline.maxX) / 2, y: (outline.minY + outline.maxY) / 2 };
    const refCentre = { x: (from.minX + from.maxX) / 2, y: (from.minY + from.maxY) / 2 };
    const candidates = ROTATIONS.map((rotationMdeg) => {
      const rot = rotatePoint(refCentre, rotationMdeg);
      return { rotationMdeg, dx: Math.round(centre.x - rot.x), dy: Math.round(centre.y - rot.y) };
    });
    const best = candidates.map((t) => ({ t, out: outsideCount(t) })).sort((x, y) => x.out - y.out || x.t.rotationMdeg - y.t.rotationMdeg)[0]!;
    fit = { transform: best.t, residualNm: 0 };
    fittedOn = 'outline';
  }

  const placements: PlacedComponent[] = [];
  const skipped: { ref: string; why: string }[] = [];
  const outsideOutline: string[] = [];
  const boxes: { ref: string; box: ReturnType<typeof extentAt> }[] = [];
  for (const { m, t, r } of pairs) {
    if (!movable.has(t.id) || t.attributes.locked) {
      skipped.push({ ref: m.targetRef, why: t.attributes.locked ? 'locked' : 'not movable' });
      continue;
    }
    const at = applyTransform(r.at, fit.transform);
    const rotation = normMdeg(r.rotation + fit.transform.rotationMdeg);
    // a side flip is refused by the exporter; a reference part on the other side keeps this board's side
    if (r.attributes.side !== t.attributes.side) skipped.push({ ref: m.targetRef, why: `reference is on the ${r.attributes.side}; kept on the ${t.attributes.side}` });
    placements.push({ id: t.id, at, rotation, side: t.attributes.side });
    const box = extentAt(t, at, rotation);
    const corners: Point[] = [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
    if (!corners.every((p) => contains(target.board.outline, p))) outsideOutline.push(m.targetRef);
    boxes.push({ ref: m.targetRef, box });
  }
  const overlapping: [string, string][] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    if (boxOverlap(boxes[i]!.box, boxes[j]!.box)) overlapping.push([boxes[i]!.ref, boxes[j]!.ref]);
  }
  return { transform: fit.transform, placements, residualNm: fit.residualNm, fittedOn, anchorRefs: anchors.map((a) => a.m.targetRef), outsideOutline, overlapping, skipped };
}

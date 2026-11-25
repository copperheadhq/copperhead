/**
 * Revision (add-reuse-placer, RFC 14 §8.8): what a hardware engineer does when
 * a critical net will not route — turn the part so its pins face where they
 * are going, swap two identical parts, or move whatever sits in the way and
 * pack that part again. Each rule proposes a placement; the caller measures it
 * the same way it measured the original and keeps it only if it is better.
 *
 * The rules are deliberately few and local. A revision that rearranges the
 * board is not a revision, it is another variant, and variants are generated
 * up front where they can be screened.
 */
import type { PcbDesign, ComponentInstance, PlacedComponent } from '../../ir/types.js';
import { intersects } from '../../ir/geometry.js';
import { normMdeg } from '../../ir/units.js';
import { poseOutline } from './transfer.js';

export type RevisionKind = 'rotate-facing' | 'swap-equal' | 'release-between';

export interface Revision {
  kind: RevisionKind;
  /** The parts this revision moves or releases. */
  refs: string[];
  note: string;
  /** New positions; empty for `release-between`, which asks the caller to repack. */
  placements: PlacedComponent[];
  /** Component ids the caller should pack again. */
  release: string[];
  /** Pin-to-pin length over the nets in question, before and after, in nanometres. */
  beforeNm: number;
  afterNm: number;
}

const QUARTERS = [0, 90_000, 180_000, 270_000];

function padsByNet(c: ComponentInstance): Map<string, { x: number; y: number }[]> {
  const out = new Map<string, { x: number; y: number }[]>();
  for (const p of c.pads) if (p.netId) (out.get(p.netId) ?? out.set(p.netId, []).get(p.netId)!).push(p.at);
  return out;
}

/** Shortest pad-to-pad distance between two parts over the nets they share. */
export function pinDistance(a: ComponentInstance, b: ComponentInstance): number {
  const bNets = padsByNet(b);
  let best = Number.POSITIVE_INFINITY;
  for (const p of a.pads) {
    if (!p.netId) continue;
    for (const q of bNets.get(p.netId) ?? []) best = Math.min(best, Math.hypot(p.at.x - q.x, p.at.y - q.y));
  }
  return best;
}

/**
 * How well a faces b: the total, over every pad of a on a net they share, of
 * the distance to the nearest pad of b on that net. This is the measure that
 * moves when a part is turned — the shortest distance alone does not, because
 * turning a two-pad part by half a turn just exchanges its pads.
 */
export function facingCost(a: ComponentInstance, b: ComponentInstance): number {
  const bNets = padsByNet(b);
  let total = 0;
  let pairs = 0;
  for (const p of a.pads) {
    if (!p.netId) continue;
    const partners = bNets.get(p.netId);
    if (!partners?.length) continue;
    total += Math.min(...partners.map((q) => Math.hypot(p.at.x - q.x, p.at.y - q.y)));
    pairs++;
  }
  return pairs ? total : Number.POSITIVE_INFINITY;
}

function placedAt(c: ComponentInstance, at: { x: number; y: number }, rotation: number): ComponentInstance {
  const d = normMdeg(rotation - c.rotation);
  const rot = (p: { x: number; y: number }) => {
    const rad = (d / 1000) * (Math.PI / 180);
    const lx = p.x - c.at.x, ly = p.y - c.at.y;
    return { x: at.x + lx * Math.cos(rad) + ly * Math.sin(rad), y: at.y - lx * Math.sin(rad) + ly * Math.cos(rad) };
  };
  return { ...c, at: { x: at.x, y: at.y }, rotation: normMdeg(rotation), pads: c.pads.map((p) => ({ ...p, at: { x: Math.round(rot(p.at).x), y: Math.round(rot(p.at).y) } })) };
}

function legalIn(design: PcbDesign, c: ComponentInstance, at: { x: number; y: number }, rotation: number, ignore: Set<string>): boolean {
  const poly = poseOutline(c, at, rotation);
  for (const other of design.components) {
    if (other.id === c.id || ignore.has(other.id)) continue;
    if (other.attributes.side !== c.attributes.side) continue;
    if (intersects(poly, poseOutline(other, other.at, other.rotation))) return false;
  }
  return true;
}

export interface ReviseInput {
  design: PcbDesign;
  /** Parts the run may move. */
  movableIds: Set<string>;
  /** The pairs that failed: a part and the part it must reach. */
  failures: { ref: string; toward: string; why: string }[];
}

/**
 * Every revision worth trying for the failures given, best first. Nothing is
 * applied here: the caller re-measures each one, because a shorter pin
 * distance that breaks a hot loop is not an improvement.
 */
export function proposeRevisions(input: ReviseInput): Revision[] {
  const { design, movableIds } = input;
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const out: Revision[] = [];
  for (const f of input.failures) {
    const a = byRef.get(f.ref), b = byRef.get(f.toward);
    if (!a || !b) continue;
    const before = facingCost(a, b);
    if (!Number.isFinite(before)) continue;

    // turn the part so the pads that reach the partner are the ones facing it
    if (movableIds.has(a.id)) {
      let best: { rotation: number; distance: number } | null = null;
      for (const r of QUARTERS) {
        const rotation = normMdeg(a.rotation + r);
        if (r !== 0 && !legalIn(design, a, a.at, rotation, new Set([b.id]))) continue;
        const d = facingCost(placedAt(a, a.at, rotation), b);
        if (!best || d < best.distance - 1000) best = { rotation, distance: d };
      }
      if (best && best.distance < before - 1000) {
        out.push({ kind: 'rotate-facing', refs: [a.reference], note: `turn ${a.reference} to face ${b.reference} (${f.why})`, placements: [{ id: a.id, at: { ...a.at }, rotation: best.rotation, side: a.attributes.side }], release: [], beforeNm: Math.round(before), afterNm: Math.round(best.distance) });
      }
    }

    // swap with an identical part that sits closer to the partner
    const twins = design.components.filter((c) => c.id !== a.id && movableIds.has(c.id) && c.footprint.libId === a.footprint.libId && c.attributes.side === a.attributes.side && c.pads.length === a.pads.length);
    for (const t of twins) {
      const after = facingCost(placedAt(a, t.at, t.rotation), b);
      if (!(after < before - 1000)) continue;
      out.push({
        kind: 'swap-equal',
        refs: [a.reference, t.reference],
        note: `swap ${a.reference} with ${t.reference}, the same footprint closer to ${b.reference} (${f.why})`,
        placements: [
          { id: a.id, at: { ...t.at }, rotation: t.rotation, side: a.attributes.side },
          { id: t.id, at: { ...a.at }, rotation: a.rotation, side: t.attributes.side },
        ],
        release: [],
        beforeNm: Math.round(before),
        afterNm: Math.round(after),
      });
      break;
    }

    // release whatever sits between them, so the packer can try again with the space freed
    const between = design.components.filter((c) => {
      if (c.id === a.id || c.id === b.id || !movableIds.has(c.id)) return false;
      const t = ((c.at.x - a.at.x) * (b.at.x - a.at.x) + (c.at.y - a.at.y) * (b.at.y - a.at.y)) / (Math.hypot(b.at.x - a.at.x, b.at.y - a.at.y) ** 2 || 1);
      if (t <= 0.05 || t >= 0.95) return false;
      const px = a.at.x + t * (b.at.x - a.at.x), py = a.at.y + t * (b.at.y - a.at.y);
      return Math.hypot(c.at.x - px, c.at.y - py) < 3_000_000;
    });
    if (between.length) {
      out.push({ kind: 'release-between', refs: between.map((c) => c.reference), note: `pack ${between.map((c) => c.reference).join(', ')} again: they sit between ${a.reference} and ${b.reference} (${f.why})`, placements: [], release: between.map((c) => c.id), beforeNm: Math.round(before), afterNm: Math.round(before) });
    }
  }
  return out.sort((x, y) => x.afterNm - x.beforeNm - (y.afterNm - y.beforeNm) || x.kind.localeCompare(y.kind));
}

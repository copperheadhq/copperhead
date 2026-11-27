/**
 * Matching (add-reuse-placer, RFC 14 §7.2): which part of the reference board
 * each part of the target board corresponds to. Matching is one-to-one and
 * greedy over tiers, strongest first, so a weaker tier never steals a part a
 * stronger one can claim. Every match carries the tier that made it: the
 * plan's confidence in a transferred position is the tier's confidence.
 *
 * T1 schematic symbol path — the same symbol, whatever the footprint or refdes
 * T2 refdes and footprint
 * T3 refdes alone (the footprint was swapped)
 * T4 footprint and net signature (the same part doing the same job)
 * T5 footprint and value
 * T6 package class and value (0603 to 0402 of the same value)
 */
import type { PcbDesign, ComponentInstance } from '../../ir/types.js';
import { bboxOf } from '../../ir/geometry.js';

export type MatchTier = 1 | 2 | 3 | 4 | 5 | 6;

/** How much a transferred position from each tier is worth; the planner reports it and the packer weights by it. */
export const TIER_CONFIDENCE: Record<MatchTier, number> = { 1: 1, 2: 0.95, 3: 0.8, 4: 0.7, 5: 0.55, 6: 0.4 };

export interface Match {
  targetId: string;
  targetRef: string;
  referenceId: string;
  referenceRef: string;
  tier: MatchTier;
  why: string;
}

export interface MatchReport {
  matches: Match[];
  unmatchedTarget: string[];
  unmatchedReference: string[];
  /** Matched share of the target's components. */
  coverage: number;
  byTier: Record<MatchTier, number>;
}

/** A part's extent: its courtyard, else the bounding box of its copper. */
export function partExtent(c: ComponentInstance): { minX: number; minY: number; maxX: number; maxY: number } {
  const polys = c.footprint.courtyard ? [c.footprint.courtyard] : c.pads.map((p) => p.copper);
  return polys.length ? bboxOf(polys) : { minX: c.at.x, minY: c.at.y, maxX: c.at.x, maxY: c.at.y };
}

export function extentArea(c: ComponentInstance): number {
  const e = partExtent(c);
  return Math.max(0, e.maxX - e.minX) * Math.max(0, e.maxY - e.minY);
}

/** The footprint's package class: the library name without the hand-solder and variant suffixes. */
export function packageClass(libId: string): string {
  const name = libId.includes(':') ? libId.slice(libId.indexOf(':') + 1) : libId;
  return name.replace(/_HandSolder$|_Pad[\d.x]+mm$|_Castellated.*$/i, '');
}

/** The size class of a two-terminal package: 0402, 0603, and so on, when the name carries one. */
export function sizeCode(libId: string): string | null {
  return packageClass(libId).match(/(?:^|_)(0\d{3}|1\d{3}|2\d{3})(?:_|$)/)?.[1] ?? null;
}

/** A package class with its size code removed: `C_0603_1608Metric` and `C_0402_1005Metric` share `C`. */
export function packageFamily(libId: string): string {
  const cls = packageClass(libId);
  const code = sizeCode(libId);
  return code ? cls.split('_')[0] ?? cls : cls;
}

/** Net names a part joins, with auto-generated names dropped: they differ between boards by construction. */
export function netSignature(c: ComponentInstance, names: Map<string, string>): string {
  const nets = c.pads
    .map((p) => (p.netId ? names.get(p.netId) ?? '' : ''))
    .filter((n) => n && !/^Net-\(/.test(n) && !/^unconnected-/.test(n))
    .map((n) => n.replace(/^\//, '').toUpperCase());
  return [...new Set(nets)].sort().join('|');
}

const normValue = (v: string) => v.trim().toUpperCase().replace(/\s+/g, '').replace(/OHMS?$/i, 'R').replace(/µ/g, 'U');

interface Side {
  comps: ComponentInstance[];
  netName: Map<string, string>;
  sig: Map<string, string>;
}

function side(design: PcbDesign): Side {
  const netName = new Map(design.nets.map((n) => [n.id, n.name]));
  const sig = new Map(design.components.map((c) => [c.id, netSignature(c, netName)]));
  return { comps: [...design.components].sort((a, b) => a.reference.localeCompare(b.reference)), netName, sig };
}

type KeyFn = (c: ComponentInstance, s: Side) => string | null;

const TIERS: { tier: MatchTier; why: string; key: KeyFn }[] = [
  { tier: 1, why: 'same schematic symbol', key: (c) => (c.symbolPath ? `path:${c.symbolPath}` : null) },
  { tier: 2, why: 'same refdes and footprint', key: (c) => `ref-fp:${c.reference}|${c.footprint.libId}` },
  { tier: 3, why: 'same refdes, footprint changed', key: (c) => `ref:${c.reference}` },
  { tier: 4, why: 'same footprint and nets', key: (c, s) => (s.sig.get(c.id) ? `fp-net:${c.footprint.libId}|${s.sig.get(c.id)}` : null) },
  { tier: 5, why: 'same footprint and value', key: (c) => (c.value ? `fp-val:${c.footprint.libId}|${normValue(c.value)}` : null) },
  { tier: 6, why: 'same package family and value', key: (c) => (c.value ? `pkg-val:${packageFamily(c.footprint.libId)}|${normValue(c.value)}` : null) },
];

/**
 * Match the target's parts to the reference's. Keys that collide on both sides
 * (four identical decoupling capacitors, say) are paired in refdes order,
 * which is stable and puts C1 with C1 whenever the boards agree on numbering.
 */
export function matchComponents(target: PcbDesign, reference: PcbDesign): MatchReport {
  const t = side(target), r = side(reference);
  const takenT = new Set<string>(), takenR = new Set<string>();
  const matches: Match[] = [];
  const byTier: Record<MatchTier, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const { tier, why, key } of TIERS) {
    const pool = new Map<string, ComponentInstance[]>();
    for (const c of r.comps) {
      if (takenR.has(c.id)) continue;
      const k = key(c, r);
      if (k) (pool.get(k) ?? pool.set(k, []).get(k)!).push(c);
    }
    for (const c of t.comps) {
      if (takenT.has(c.id)) continue;
      const k = key(c, t);
      if (!k) continue;
      const bucket = pool.get(k);
      if (!bucket?.length) continue;
      // prefer the candidate with the same refdes, then the closest pad count, then refdes order
      bucket.sort((a, b) => Number(b.reference === c.reference) - Number(a.reference === c.reference) || Math.abs(a.pads.length - c.pads.length) - Math.abs(b.pads.length - c.pads.length) || a.reference.localeCompare(b.reference));
      const pick = bucket.shift()!;
      takenT.add(c.id);
      takenR.add(pick.id);
      byTier[tier]++;
      matches.push({ targetId: c.id, targetRef: c.reference, referenceId: pick.id, referenceRef: pick.reference, tier, why });
    }
  }
  const unmatchedTarget = t.comps.filter((c) => !takenT.has(c.id)).map((c) => c.id);
  const unmatchedReference = r.comps.filter((c) => !takenR.has(c.id)).map((c) => c.id);
  return {
    matches: matches.sort((a, b) => a.targetRef.localeCompare(b.targetRef)),
    unmatchedTarget,
    unmatchedReference,
    coverage: t.comps.length ? matches.length / t.comps.length : 0,
    byTier,
  };
}

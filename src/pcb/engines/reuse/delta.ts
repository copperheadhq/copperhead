/**
 * The delta (add-reuse-placer, RFC 14 §7.4): everything that differs between
 * the reference board and the board being placed, as a table. It is what the
 * planner reads before it writes a plan, and what the run report shows a
 * reader who wants to know why the placement is not simply a copy.
 */
import type { PcbDesign, ComponentInstance } from '../../ir/types.js';
import { area, bbox } from '../../ir/geometry.js';
import type { Match, MatchReport } from './match.js';
import { extentArea, netSignature, packageFamily } from './match.js';

export interface DeltaPart {
  ref: string;
  footprint: string;
  value: string;
  pads: number;
}

export interface DeltaChange {
  ref: string;
  referenceRef: string;
  from: string;
  to: string;
  /** Target extent over reference extent. */
  areaRatio: number;
  /** Net names the part gained and lost, when either board names them. */
  netsAdded: string[];
  netsRemoved: string[];
  tier: Match['tier'];
}

export interface Delta {
  added: DeltaPart[];
  removed: DeltaPart[];
  changed: DeltaChange[];
  outline: { referenceMm: { w: number; h: number }; targetMm: { w: number; h: number }; areaRatio: number };
  /** Courtyard area over board area on each board, front side. */
  utilisation: { reference: number; target: number };
  coverage: number;
  byTier: MatchReport['byTier'];
  netsAdded: string[];
  netsRemoved: string[];
}

const mm = (nm: number) => Number((nm / 1e6).toFixed(2));

function utilisation(design: PcbDesign): number {
  const boardArea = Math.abs(area(design.board.outline)) - design.board.cutouts.reduce((a, c) => a + Math.abs(area(c)), 0);
  if (boardArea <= 0) return 0;
  const used = design.components.filter((c) => c.attributes.side === 'front').reduce((a, c) => a + extentArea(c), 0);
  return Number((used / boardArea).toFixed(3));
}

const part = (c: ComponentInstance): DeltaPart => ({ ref: c.reference, footprint: c.footprint.libId, value: c.value, pads: c.pads.length });

export function computeDelta(target: PcbDesign, reference: PcbDesign, report: MatchReport): Delta {
  const tById = new Map(target.components.map((c) => [c.id, c]));
  const rById = new Map(reference.components.map((c) => [c.id, c]));
  const tNames = new Map(target.nets.map((n) => [n.id, n.name]));
  const rNames = new Map(reference.nets.map((n) => [n.id, n.name]));
  const changed: DeltaChange[] = [];
  for (const m of report.matches) {
    const t = tById.get(m.targetId), r = rById.get(m.referenceId);
    if (!t || !r) continue;
    const tSig = new Set(netSignature(t, tNames).split('|').filter(Boolean));
    const rSig = new Set(netSignature(r, rNames).split('|').filter(Boolean));
    const netsAdded = [...tSig].filter((n) => !rSig.has(n)).sort();
    const netsRemoved = [...rSig].filter((n) => !tSig.has(n)).sort();
    if (t.footprint.libId === r.footprint.libId && !netsAdded.length && !netsRemoved.length) continue;
    const ra = extentArea(r);
    changed.push({ ref: t.reference, referenceRef: r.reference, from: r.footprint.libId, to: t.footprint.libId, areaRatio: ra ? Number((extentArea(t) / ra).toFixed(2)) : 0, netsAdded, netsRemoved, tier: m.tier });
  }
  const tb = bbox(target.board.outline), rb = bbox(reference.board.outline);
  const tArea = Math.abs(area(target.board.outline)), rArea = Math.abs(area(reference.board.outline));
  const tNetSet = new Set(target.nets.map((n) => n.name).filter((n) => n && !/^Net-\(/.test(n)));
  const rNetSet = new Set(reference.nets.map((n) => n.name).filter((n) => n && !/^Net-\(/.test(n)));
  return {
    added: report.unmatchedTarget.map((id) => part(tById.get(id)!)).sort((a, b) => a.ref.localeCompare(b.ref)),
    removed: report.unmatchedReference.map((id) => part(rById.get(id)!)).sort((a, b) => a.ref.localeCompare(b.ref)),
    changed: changed.sort((a, b) => a.ref.localeCompare(b.ref)),
    outline: {
      referenceMm: { w: mm(rb.maxX - rb.minX), h: mm(rb.maxY - rb.minY) },
      targetMm: { w: mm(tb.maxX - tb.minX), h: mm(tb.maxY - tb.minY) },
      areaRatio: rArea ? Number((tArea / rArea).toFixed(2)) : 0,
    },
    utilisation: { reference: utilisation(reference), target: utilisation(target) },
    coverage: Number(report.coverage.toFixed(3)),
    byTier: report.byTier,
    netsAdded: [...tNetSet].filter((n) => !rNetSet.has(n)).sort(),
    netsRemoved: [...rNetSet].filter((n) => !tNetSet.has(n)).sort(),
  };
}

/** The delta as markdown: the planner's input and the report's table. */
export function deltaTable(delta: Delta): string {
  const lines: string[] = [];
  const tiers = Object.entries(delta.byTier).filter(([, n]) => n > 0).map(([t, n]) => `T${t}:${n}`).join(' ');
  lines.push(`Matched ${(delta.coverage * 100).toFixed(0)} % of the parts (${tiers || 'none'}).`);
  lines.push(`Outline ${delta.outline.referenceMm.w}x${delta.outline.referenceMm.h} mm -> ${delta.outline.targetMm.w}x${delta.outline.targetMm.h} mm (area x${delta.outline.areaRatio}).`);
  lines.push(`Front utilisation ${(delta.utilisation.reference * 100).toFixed(0)} % -> ${(delta.utilisation.target * 100).toFixed(0)} %.`);
  if (delta.added.length) {
    lines.push('', '### Parts with no counterpart on the reference', '', '| Ref | Footprint | Value | Pads |', '| --- | --- | --- | --- |');
    for (const p of delta.added) lines.push(`| ${p.ref} | ${p.footprint} | ${p.value} | ${p.pads} |`);
  }
  if (delta.removed.length) {
    lines.push('', '### Reference parts this board does not have', '', '| Ref | Footprint | Value |', '| --- | --- | --- |');
    for (const p of delta.removed) lines.push(`| ${p.ref} | ${p.footprint} | ${p.value} |`);
  }
  if (delta.changed.length) {
    lines.push('', '### Parts that changed', '', '| Ref | Reference | From | To | Area | Nets gained | Nets lost |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const c of delta.changed) lines.push(`| ${c.ref} | ${c.referenceRef} | ${packageFamily(c.from)} ${c.from} | ${packageFamily(c.to)} ${c.to} | x${c.areaRatio} | ${c.netsAdded.join(', ') || '-'} | ${c.netsRemoved.join(', ') || '-'} |`);
  }
  if (delta.netsAdded.length || delta.netsRemoved.length) {
    lines.push('', `Nets gained: ${delta.netsAdded.join(', ') || 'none'}.`, `Nets lost: ${delta.netsRemoved.join(', ') || 'none'}.`);
  }
  return lines.join('\n');
}

/**
 * Variants (add-reuse-placer, RFC 14 §8.5): a placement run does not produce
 * one board, it produces several and keeps the ones that survive screening.
 * The axes are the decisions nobody can make correctly in advance:
 *
 * - **how much of the reference to keep** — option A keeps every position that
 *   is still legal, option B repacks but is pulled toward the reference,
 *   option C ignores it and packs from the connections alone;
 * - **how hard the pull is** — the attractor's network weight;
 * - **which subsystem partition** the plan groups by;
 * - **how much room every part is given** — inflation beyond the clearance,
 *   which trades density for routability.
 *
 * The list is deterministic and ordered best-guess first, so a caller that can
 * only afford the first few still gets the variants most likely to win.
 */
import type { PackVariant } from '../placers/reuse-pack/adapter.js';

export interface VariantSpec extends PackVariant {
  /** Which option of RFC 14 §8.5 this is, for the report. */
  option: 'A' | 'B' | 'C';
  note: string;
}

export interface VariantOptions {
  /** Partition keys to try, best first; only the first two are used. */
  partitions: string[];
  /** Without a reference there is nothing to keep, so options A and B collapse into C. */
  hasReference: boolean;
  /** Clearance in nanometres, the unit inflation is measured in. */
  clearanceNm: number;
  /** `screen` is the in-memory sweep; `quick` is what a single `pcb place` run uses. */
  budget?: 'quick' | 'screen';
}

/** The variants to try, deterministic and ordered best-guess first. */
export function enumerateVariants(opts: VariantOptions): VariantSpec[] {
  const parts = opts.partitions.slice(0, 2);
  const partitionOf = (i: number) => (parts[i] !== undefined ? { partition: parts[i]! } : {});
  const out: VariantSpec[] = [];
  const add = (v: VariantSpec) => {
    if (!out.some((x) => x.id === v.id)) out.push(v);
  };
  if (opts.hasReference) {
    add({ id: 'a0', option: 'A', planFirst: true, attraction: 3, ...partitionOf(0), note: 'keep every reference position that is still legal' });
    add({ id: 'a1', option: 'A', planFirst: true, attraction: 3, inflationNm: opts.clearanceNm * 2, ...partitionOf(0), note: 'keep the reference, with more room around every part' });
    add({ id: 'b0', option: 'B', planFirst: false, attraction: 3, ...partitionOf(0), note: 'repack, pulled toward the reference' });
    add({ id: 'b1', option: 'B', planFirst: false, attraction: 8, ...partitionOf(0), note: 'repack, pulled hard toward the reference' });
    add({ id: 'b2', option: 'B', planFirst: false, attraction: 1, ...partitionOf(0), note: 'repack, barely pulled toward the reference' });
  }
  add({ id: 'c0', option: 'C', planFirst: false, attraction: 0, ...partitionOf(0), note: 'pack from the connections alone' });
  if (opts.budget === 'quick') return out.slice(0, opts.hasReference ? 3 : 1);
  if (opts.hasReference && parts[1] !== undefined) {
    add({ id: 'a0-p2', option: 'A', planFirst: true, attraction: 3, ...partitionOf(1), note: 'keep the reference, grouped the second way' });
    add({ id: 'b0-p2', option: 'B', planFirst: false, attraction: 3, ...partitionOf(1), note: 'repack toward the reference, grouped the second way' });
  }
  add({ id: 'c1', option: 'C', planFirst: false, attraction: 0, inflationNm: opts.clearanceNm * 2, ...partitionOf(0), note: 'pack from the connections, with more room' });
  if (opts.hasReference) {
    add({ id: 'b3', option: 'B', planFirst: false, attraction: 3, inflationNm: opts.clearanceNm * 2, ...partitionOf(0), note: 'repack toward the reference, with more room' });
    add({ id: 'b4', option: 'B', planFirst: false, attraction: 3, rotations: [0, 180], ...partitionOf(0), note: 'repack toward the reference, keeping every part upright' });
  }
  return out;
}

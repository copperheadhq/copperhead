/**
 * Tiered ranking (RFC 15 Section 11): the engineer's order decides before the
 * weighted score does, and a profile without tiers ranks exactly as it did
 * before.
 */
import { describe, it, expect } from 'vitest';
import { rank } from '../src/pcb/verify/scoring.js';
import { loadScoringProfile, ENGINEERING_PLACEMENT_2_LAYER, DEFAULT_PLACEMENT_2_LAYER } from '../src/pcb/verify/profiles/scoring/index.js';
import type { ScoredInput } from '../src/pcb/verify/scoring.js';

const clean = { courtyard_overlap_count: 0, outside_board_count: 0, unplaced_count: 0, drc_placement_critical_count: 0, intent_hard_violations: 0, isolation_min_mm: 2, routability_completion: 1, congestion_overflow: 0, runtime_s: 1 };
const candidate = (id: string, metrics: Record<string, number>): ScoredInput => ({ id, metrics: { ...clean, ...metrics }, gatesPassed: true, gateFailures: [] });

describe('tiered ranking', () => {
  // the tight loop is 2x the wirelength: a weighted score would take the short board
  const tightLoop = candidate('tight-loop', { loop_area_mm2: 1, hpwl_nm: 200_000_000 });
  const shortWires = candidate('short-wires', { loop_area_mm2: 5, hpwl_nm: 100_000_000 });

  it('a smaller current loop beats a shorter board, because its tier comes first', () => {
    const ranked = rank([shortWires, tightLoop], ENGINEERING_PLACEMENT_2_LAYER);
    expect(ranked.selected).toBe('tight-loop');
    expect(ranked.candidates[0]!.eligible).toBe(true);
  });

  it('without tiers the same two candidates rank on the weighted score, as before', () => {
    const ranked = rank([shortWires, tightLoop], DEFAULT_PLACEMENT_2_LAYER);
    expect(ranked.selected).toBe('short-wires');
  });

  it('a tier only decides when the difference is real', () => {
    const a = candidate('a', { loop_area_mm2: 1, hpwl_nm: 200_000_000 });
    const b = candidate('b', { loop_area_mm2: 1, hpwl_nm: 100_000_000 });
    // the loop tier ties, so the next tiers decide and the shorter board wins
    expect(rank([a, b], ENGINEERING_PLACEMENT_2_LAYER).selected).toBe('b');
  });

  it('an ineligible candidate never outranks an eligible one, whatever its tiers', () => {
    const broken = candidate('broken', { loop_area_mm2: 0, hpwl_nm: 1, courtyard_overlap_count: 2 });
    const ranked = rank([broken, shortWires], ENGINEERING_PLACEMENT_2_LAYER);
    expect(ranked.selected).toBe('short-wires');
    expect(ranked.candidates.find((c) => c.id === 'broken')!.eligible).toBe(false);
  });

  it('the profile is registered and carries the tiers of RFC 15, in order', () => {
    const p = loadScoringProfile('engineering-placement-2-layer');
    expect(p.tiers?.map((t) => t.name)).toEqual([
      'hard intent',
      'T1 mechanical correctness',
      'T2 datasheet-required placement',
      'T3 antenna and thermal',
      'T4 critical routing',
      'T5 high-current loop area',
      'T6 sensitive signal separation',
      'T8 routability',
      'T9 trace length',
    ]);
    expect(loadScoringProfile('default-placement-2-layer').tiers).toBeUndefined();
  });

  it('a board whose critical nets route beats one with a smaller loop (T4 before T5)', () => {
    const routes = candidate('routes', { critical_completion: 1, loop_area_mm2: 30 });
    const tight = candidate('tight', { critical_completion: 0.8, loop_area_mm2: 5 });
    const ranked = rank([tight, routes], ENGINEERING_PLACEMENT_2_LAYER);
    expect(ranked.selected).toBe('routes');
    expect(ranked.candidates[0]!.reason).toContain('ahead of tight on T4 critical routing');
  });

  it('decoupling at its pins beats critical routing (T2 before T4)', () => {
    const near = candidate('near', { datasheet_soft_violations: 0, critical_completion: 0.9 });
    const far = candidate('far', { datasheet_soft_violations: 4, critical_completion: 1 });
    expect(rank([far, near], ENGINEERING_PLACEMENT_2_LAYER).selected).toBe('near');
  });

  it('a candidate not measured on a tier ties on it, and the next tier decides', () => {
    const measured = candidate('measured', { critical_completion: 1, loop_area_mm2: 50 });
    const unmeasured = candidate('unmeasured', { loop_area_mm2: 10 });
    const ranked = rank([measured, unmeasured], ENGINEERING_PLACEMENT_2_LAYER);
    expect(ranked.selected).toBe('unmeasured');
    expect(ranked.candidates[0]!.reason).toContain('on T5 high-current loop area');
  });

  it('loop area and length tie inside their relative tolerances', () => {
    const a = candidate('a', { loop_area_mm2: 100, hpwl_nm: 100_000_000, routability_completion: 0.9 });
    const b = candidate('b', { loop_area_mm2: 109, hpwl_nm: 104_000_000, routability_completion: 1 });
    // 9 % on loop area and 4 % on length are ties; routability decides
    expect(rank([a, b], ENGINEERING_PLACEMENT_2_LAYER).selected).toBe('b');
  });
});

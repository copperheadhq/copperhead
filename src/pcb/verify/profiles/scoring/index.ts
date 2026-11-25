/**
 * One metric of a tier (RFC 15 Section 11.1): which way is better, and the
 * tolerance inside which two values count as equal. A relative tolerance is a
 * share of the larger of the two values.
 */
export interface TierMetric {
  key: string;
  better: 'lower' | 'higher';
  tolerance: number;
  relative?: boolean;
}

/** A tier: a name for the reader, and its metrics in comparison order. */
export interface Tier {
  name: string;
  metrics: TierMetric[];
}

/** Scoring profiles (RFC 11 §11.3, ADR 0006). Weights apply to normalized, minimize-all metrics. */
export interface ScoringProfile {
  id: string;
  /** Hard gates on raw metrics: a candidate failing one is ineligible. */
  gates: Record<string, { max?: number; min?: number }>;
  /** Weighted metrics; `higherIsBetter` metrics are negated before normalization. */
  weights: Record<string, number>;
  higherIsBetter: string[];
  /**
   * Ordered tiers (RFC 15 Section 11). A candidate better in an earlier tier
   * wins whatever the later tiers say, which is how a hardware engineer
   * decides: a violated hot loop is not paid for by a shorter net. Within a
   * tier the metrics are compared in order, each inside its own tolerance; a
   * metric a candidate was not measured on compares as unknown and ties
   * (Section 11.2). Profiles without tiers rank exactly as they did before.
   */
  tiers?: Tier[];
}

const lower = (key: string, tolerance: number, relative = false): TierMetric => ({ key, better: 'lower', tolerance, ...(relative ? { relative } : {}) });
const higher = (key: string, tolerance: number): TierMetric => ({ key, better: 'higher', tolerance });

/**
 * The engineer's order: the ten tiers of RFC 15 Section 11.1, with their
 * default tolerances. Hard intent violations, which the RFC makes gates,
 * come first among eligible candidates. T7 (pin-facing orientation) and T10
 * (visual neatness) have no metric yet, so they tie.
 */
export const RFC15_TIERS: Tier[] = [
  { name: 'hard intent', metrics: [lower('intent_hard_violations', 0)] },
  { name: 'T1 mechanical correctness', metrics: [lower('mechanical_soft_violations', 0), lower('mechanical_offset_mm', 0.1)] },
  { name: 'T2 datasheet-required placement', metrics: [lower('datasheet_soft_violations', 0), lower('datasheet_excess_mm', 0.25)] },
  { name: 'T3 antenna and thermal', metrics: [lower('radio_thermal_violations', 0), higher('rf_clearance_min_mm', 0.5)] },
  { name: 'T4 critical routing', metrics: [higher('critical_completion', 0)] },
  { name: 'T5 high-current loop area', metrics: [lower('loop_area_mm2', 0.1, true)] },
  { name: 'T6 sensitive signal separation', metrics: [lower('separation_violations', 0), higher('isolation_min_mm', 0.5)] },
  { name: 'T8 routability', metrics: [higher('routability_completion', 0.02), lower('congestion_overflow', 0.05, true)] },
  { name: 'T9 trace length', metrics: [lower('hpwl_nm', 0.05, true)] },
];

/**
 * The placement profile of RFC 15: its tiers decide, and the weighted score
 * breaks final ties. Metrics a candidate does not carry tie, so a run without
 * a probe simply decides on the tiers it can measure.
 */
export const ENGINEERING_PLACEMENT_2_LAYER: ScoringProfile = {
  id: 'engineering-placement-2-layer',
  gates: { courtyard_overlap_count: { max: 0 }, outside_board_count: { max: 0 }, unplaced_count: { max: 0 }, drc_placement_critical_count: { max: 0 } },
  weights: { routability_completion: 0.35, hpwl_nm: 0.3, congestion_overflow: 0.2, drc_error_count: 0.1, runtime_s: 0.05 },
  higherIsBetter: ['routability_completion', 'isolation_min_mm', 'critical_completion', 'rf_clearance_min_mm'],
  tiers: RFC15_TIERS,
};

export const DEFAULT_LOW_SPEED_2_LAYER: ScoringProfile = {
  id: 'default-low-speed-2-layer',
  gates: { drc_critical_count: { max: 0 }, shorts: { max: 0 } },
  weights: {
    completion_rate: 0.3,
    pour_largest_share: 0.15,
    bottom_signal_length_nm: 0.15,
    total_wirelength_nm: 0.12,
    via_count: 0.12,
    tight_segment_share: 0.06,
    drc_error_count: 0.05,
    runtime_s: 0.05,
  },
  higherIsBetter: ['completion_rate', 'pour_largest_share'],
};

/**
 * Four and six layers (add-multilayer-layout D4): the return path is the plane layers, so the two-layer
 * bottom-copper terms are dropped and the rest renormalised; a plane-integrity metric is later work.
 */
function withoutReturnPath(id: string): ScoringProfile {
  const kept = Object.entries(DEFAULT_LOW_SPEED_2_LAYER.weights).filter(([k]) => k !== 'pour_largest_share' && k !== 'bottom_signal_length_nm');
  const total = kept.reduce((s, [, w]) => s + w, 0);
  return { id, gates: { ...DEFAULT_LOW_SPEED_2_LAYER.gates }, weights: Object.fromEntries(kept.map(([k, w]) => [k, Math.round((w / total) * 1e4) / 1e4])), higherIsBetter: DEFAULT_LOW_SPEED_2_LAYER.higherIsBetter.filter((k) => k !== 'pour_largest_share') };
}
export const DEFAULT_LOW_SPEED_4_LAYER: ScoringProfile = withoutReturnPath('default-low-speed-4-layer');
export const DEFAULT_LOW_SPEED_6_LAYER: ScoringProfile = withoutReturnPath('default-low-speed-6-layer');

/** The routing scoring profile for a copper count. */
export function defaultRoutingScoringFor(copperLayers: number): string {
  return copperLayers >= 6 ? DEFAULT_LOW_SPEED_6_LAYER.id : copperLayers >= 4 ? DEFAULT_LOW_SPEED_4_LAYER.id : DEFAULT_LOW_SPEED_2_LAYER.id;
}

/** Placement candidates (RFC 11 §11.1): routability first, then wirelength and congestion; overlaps and off-board parts are gates. */
export const DEFAULT_PLACEMENT_2_LAYER: ScoringProfile = {
  id: 'default-placement-2-layer',
  gates: { courtyard_overlap_count: { max: 0 }, outside_board_count: { max: 0 }, intent_hard_violations: { max: 0 } },
  weights: {
    routability_completion: 0.35,
    hpwl_nm: 0.3,
    congestion_overflow: 0.2,
    routability_drc_errors: 0.1,
    runtime_s: 0.05,
  },
  higherIsBetter: ['routability_completion'],
};

const SCORING: Record<string, ScoringProfile> = { [DEFAULT_LOW_SPEED_2_LAYER.id]: DEFAULT_LOW_SPEED_2_LAYER, [DEFAULT_PLACEMENT_2_LAYER.id]: DEFAULT_PLACEMENT_2_LAYER, [DEFAULT_LOW_SPEED_4_LAYER.id]: DEFAULT_LOW_SPEED_4_LAYER, [DEFAULT_LOW_SPEED_6_LAYER.id]: DEFAULT_LOW_SPEED_6_LAYER, [ENGINEERING_PLACEMENT_2_LAYER.id]: ENGINEERING_PLACEMENT_2_LAYER };

export function loadScoringProfile(id: string): ScoringProfile {
  const p = SCORING[id];
  if (!p) throw new Error(`unknown scoring profile "${id}" (known: ${Object.keys(SCORING).join(', ')})`);
  return p;
}

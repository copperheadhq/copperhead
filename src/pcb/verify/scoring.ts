/**
 * Ranking (RFC 11 §11.3, AC-17.7): hard gates first, then lexicographic on
 * completion and constraint compliance, then a Pareto frontier over the
 * profile's metrics; the weighted profile picks a default, raw metrics and
 * Pareto membership are always kept. An ineligible candidate can never
 * outrank an eligible one, whatever its wirelength.
 */
import type { ScoringProfile } from './profiles/scoring/index.js';

export interface ScoredInput {
  id: string;
  metrics: Record<string, number>;
  /** From the verification gates: preflight, placement, routing. */
  gatesPassed: boolean;
  gateFailures: string[];
  hardIntentViolations?: number;
  softIntentViolations?: number;
}

export interface RankedCandidate extends ScoredInput {
  eligible: boolean;
  /** Names of profile gates the candidate failed (besides verification gates). */
  profileGateFailures: string[];
  pareto: boolean;
  /** Weighted score, lower is better; null when ineligible. */
  score: number | null;
  rank: number;
  reason: string;
}

export interface Ranking {
  profile: string;
  candidates: RankedCandidate[];
  selected: string | null;
  reason: string;
}

function dominates(a: number[], b: number[]): boolean {
  let strictly = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! > b[i]!) return false;
    if (a[i]! < b[i]!) strictly = true;
  }
  return strictly;
}

export function rank(inputs: ScoredInput[], profile: ScoringProfile): Ranking {
  const keys = Object.keys(profile.weights);
  const vectors = new Map<string, number[]>();
  const withFlags = inputs.map((c) => {
    const profileGateFailures: string[] = [];
    for (const [k, g] of Object.entries(profile.gates)) {
      const v = c.metrics[k];
      if (v === undefined) continue;
      if (g.max !== undefined && v > g.max) profileGateFailures.push(`${k} ${v} > ${g.max}`);
      if (g.min !== undefined && v < g.min) profileGateFailures.push(`${k} ${v} < ${g.min}`);
    }
    const eligible = c.gatesPassed && profileGateFailures.length === 0;
    // minimize-all vector
    vectors.set(c.id, keys.map((k) => (profile.higherIsBetter.includes(k) ? -(c.metrics[k] ?? 0) : (c.metrics[k] ?? 0))));
    return { c, eligible, profileGateFailures };
  });
  const eligible = withFlags.filter((x) => x.eligible);
  // normalize each metric across eligible candidates
  const mins = keys.map((_, i) => Math.min(...eligible.map((x) => vectors.get(x.c.id)![i]!), Infinity));
  const maxs = keys.map((_, i) => Math.max(...eligible.map((x) => vectors.get(x.c.id)![i]!), -Infinity));
  const score = (id: string): number => {
    const v = vectors.get(id)!;
    let s = 0;
    keys.forEach((k, i) => {
      const range = maxs[i]! - mins[i]!;
      const norm = range > 0 ? (v[i]! - mins[i]!) / range : 0;
      s += norm * (profile.weights[k] ?? 0);
    });
    return s;
  };
  const ranked: RankedCandidate[] = withFlags.map((x) => {
    const pareto = x.eligible && !eligible.some((o) => o.c.id !== x.c.id && dominates(vectors.get(o.c.id)!, vectors.get(x.c.id)!));
    return { ...x.c, eligible: x.eligible, profileGateFailures: x.profileGateFailures, pareto, score: x.eligible ? score(x.c.id) : null, rank: 0, reason: '' };
  });
  /**
   * RFC 15 Section 11.2: tier by tier, each tier's metrics in order. Two
   * values inside the metric's tolerance are equal; a metric either candidate
   * was not measured on is unknown and ties. Returns the sign of the
   * comparison and the tier that decided it.
   */
  const decidedBy = new Map<string, string>();
  const byTier = (a: RankedCandidate, b: RankedCandidate): number => {
    for (const tier of profile.tiers ?? []) {
      for (const m of tier.metrics) {
        const va = a.metrics[m.key];
        const vb = b.metrics[m.key];
        if (va === undefined || vb === undefined) continue;
        const room = m.relative ? m.tolerance * Math.max(Math.abs(va), Math.abs(vb)) : m.tolerance;
        if (Math.abs(va - vb) <= room) continue;
        const sign = m.better === 'lower' ? Math.sign(va - vb) : Math.sign(vb - va);
        const winner = sign < 0 ? a.id : b.id;
        const loser = sign < 0 ? b.id : a.id;
        decidedBy.set(`${winner}>${loser}`, tier.name);
        return sign;
      }
    }
    return 0;
  };

  // lexicographic: eligible, completion desc, hard intent asc, soft intent asc, tiers, score asc
  ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const ca = a.metrics.completion_rate ?? 0;
    const cb = b.metrics.completion_rate ?? 0;
    if (ca !== cb) return cb - ca;
    const ha = a.hardIntentViolations ?? 0;
    const hb = b.hardIntentViolations ?? 0;
    if (ha !== hb) return ha - hb;
    const sa = a.softIntentViolations ?? 0;
    const sb = b.softIntentViolations ?? 0;
    if (sa !== sb) return sa - sb;
    if (a.eligible && b.eligible && profile.tiers?.length) {
      const t = byTier(a, b);
      if (t !== 0) return t;
    }
    return (a.score ?? Infinity) - (b.score ?? Infinity);
  });
  ranked.forEach((c, i) => {
    c.rank = i + 1;
    // What put this candidate above the next one: the tier that decided, or the weighted score.
    const next = ranked[i + 1];
    let ahead = '';
    if (c.eligible && next?.eligible && profile.tiers?.length) {
      const t = byTier(c, next);
      const tier = t < 0 ? decidedBy.get(`${c.id}>${next.id}`) : undefined;
      if (tier) ahead = `; ahead of ${next.id} on ${tier}`;
      else if (t === 0 && (c.score ?? Infinity) < (next.score ?? Infinity)) ahead = `; ahead of ${next.id} on the weighted score, the tiers tied`;
    }
    c.reason = !c.eligible
      ? `ineligible: ${[...c.gateFailures, ...c.profileGateFailures].join('; ') || 'verification gate'}`
      : `${headline(c.metrics)}weighted score ${c.score!.toFixed(3)}${c.pareto ? ', on the Pareto frontier' : ''}${ahead}`;
  });
  const selected = ranked.find((c) => c.eligible) ?? null;
  return { profile: profile.id, candidates: ranked, selected: selected?.id ?? null, reason: selected ? `${selected.id}: ${selected.reason}` : 'no eligible candidate' };
}

/** The one number a reader wants first: routing completion for routed candidates, probed routability and wirelength for placements. */
function headline(m: Record<string, number | undefined>): string {
  if (m.completion_rate !== undefined) return `completion ${(m.completion_rate * 100).toFixed(0)}%, `;
  const parts: string[] = [];
  if (m.routability_completion !== undefined) parts.push(`routability ${(m.routability_completion * 100).toFixed(0)}%`);
  if (m.hpwl_nm !== undefined) parts.push(`HPWL ${(m.hpwl_nm / 1e6).toFixed(1)} mm`);
  return parts.length ? `${parts.join(', ')}, ` : '';
}

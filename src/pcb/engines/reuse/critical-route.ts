/**
 * Critical routing (add-reuse-placer, RFC 14 §8.7): the engineer's last step
 * before accepting a placement is routing the few nets that decide whether the
 * board works, and moving parts when they will not route. Routing every net
 * would cost minutes per candidate; routing the critical ones costs seconds
 * and answers the only question placement can still get wrong.
 *
 * The copper is thrown away afterwards. This is a measurement, not a routing
 * run: what survives is whether each critical net closed, how long it came
 * out, and whether it brought critical DRC with it.
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { importBoard } from '../../ir/kicad/import.js';
import type { PcbDesign } from '../../ir/types.js';
import type { Constraint } from '../../../memory/constraints.js';
import type { Classification } from '../../intent/critical.js';
import { CLASS_WEIGHT } from '../../intent/critical.js';
import { routeBoard, type RouteOptions } from '../route.js';

/** Class weight at or above which a net is worth routing before the placement is accepted. */
export const CRITICAL_NET_WEIGHT = 4;

export interface CriticalRouteResult {
  /** The nets that were routed, in the order they were given to the router. */
  nets: string[];
  /** Nets that still owe connections after the router ran. */
  unrouted: string[];
  completion: number;
  drcCritical: number;
  /** Track length per net, nanometres, for the nets that closed. */
  lengthNm: Record<string, number>;
  seconds: number;
  /** Set when the router could not run at all (not installed, no budget); the caller must not read this as a failure of the placement. */
  unavailable?: string;
}

/**
 * The nets worth routing early: the ones a critical relationship gave weight
 * to, plus any net the board's own intent declares a width or priority for.
 * Ground and the power rails are excluded — they are planes and pours, and a
 * placement is not what decides them.
 */
export function criticalNetNames(design: PcbDesign, classification: Classification, registry: Record<string, Constraint> = {}): string[] {
  const names = new Set<string>();
  for (const [net, weight] of classification.netWeights) if (weight >= CRITICAL_NET_WEIGHT) names.add(net);
  for (const [key, c] of Object.entries(registry)) {
    if (!key.startsWith('layout.routing.')) continue;
    for (const n of c.scope?.nets ?? []) names.add(n);
  }
  const known = new Set(design.nets.map((n) => n.name));
  return [...names].filter((n) => known.has(n)).sort();
}

export interface CriticalRouteOptions {
  repoRoot: string;
  /** A materialised candidate board: routing writes beside it, never over the source. */
  boardPath: string;
  projectPath?: string;
  workDir: string;
  nets: string[];
  routerId?: string;
  budgetSeconds?: number;
  /**
   * Extra clearance the router is asked to leave, beyond the board's rule.
   * Default zero, deliberately: Freerouting routes to its own clearance model
   * and KiCad then disagrees at the margin (measured here: 0.8 um to 30 um), but
   * a margin large enough to absorb that also stops dense boards routing at all
   * — 40 um took one case from five nets routed to none. The benchmark reports
   * such a failure and attributes it against the designer's own board instead.
   */
  clearanceMarginNm?: number;
  seed?: number;
  profile?: string;
  registry?: RouteOptions['registry'];
  policy?: RouteOptions['policy'];
  noKicad?: boolean;
  log?: (line: string) => void;
}

/** Route only the critical nets on a candidate and report what happened. */
export async function routeCriticalNets(opts: CriticalRouteOptions): Promise<CriticalRouteResult> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const empty: CriticalRouteResult = { nets: opts.nets, unrouted: [], completion: 1, drcCritical: 0, lengthNm: {}, seconds: 0 };
  if (!opts.nets.length) return empty;
  const runDir = path.join(opts.workDir, 'critical-route');
  await mkdir(runDir, { recursive: true });
  const budget = opts.budgetSeconds ?? 90;
  // the board's own clearance plus the margin the router needs to satisfy KiCad
  const design = importBoard({ boardText: await readFile(opts.boardPath, 'utf8'), boardPath: opts.boardPath }).design;
  const clearance = design.board.rules.clearanceNm + (opts.clearanceMarginNm ?? 0);
  let run;
  try {
    run = await routeBoard({
      repoRoot: opts.repoRoot,
      boardPath: opts.boardPath,
      ...(opts.projectPath ? { projectPath: opts.projectPath } : {}),
      runDir,
      netNames: opts.nets,
      preserveExistingRoutes: false,
      strategy: { clearanceNm: clearance },
      ...(opts.routerId ? { routers: [opts.routerId] } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.registry ? { registry: opts.registry } : {}),
      ...(opts.policy ? { policy: opts.policy } : {}),
      ...(opts.noKicad ? { noKicad: true } : {}),
      limits: { engineSeconds: budget, wallSeconds: budget },
      maxParallel: 1,
      log: (l) => log(`  critical-route: ${l}`),
    });
  } catch (e) {
    return { ...empty, seconds: (Date.now() - t0) / 1000, unavailable: (e as Error).message };
  }
  const chosen = (run.ranking.selected ? run.candidates.find((c) => c.engineId === run.ranking.selected) : undefined) ?? run.candidates[0];
  if (!chosen) return { ...empty, seconds: (Date.now() - t0) / 1000, unavailable: run.outcome.summary };

  // completion over the critical nets only: the run's own completion counts the whole board
  const wanted = new Set(opts.nets);
  const unrouted = [...new Set(chosen.verify.diagnostics.filter((d) => d.code === 'conn.unrouted' && wanted.has(d.entityReferences[0] ?? '')).map((d) => d.entityReferences[0]!))].sort();
  const padOf = new Map<string, string>();
  for (const c of chosen.design.components) for (const p of c.pads) if (p.netId) padOf.set(p.id, p.netId);
  const netName = new Map(chosen.design.nets.map((n) => [n.id, n.name]));
  const lengthNm: Record<string, number> = {};
  for (const s of chosen.design.routing.segments) {
    const name = s.netId ? netName.get(s.netId) : undefined;
    if (!name || !wanted.has(name)) continue;
    lengthNm[name] = (lengthNm[name] ?? 0) + Math.round(Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y));
  }
  const result: CriticalRouteResult = {
    nets: opts.nets,
    unrouted,
    completion: opts.nets.length ? (opts.nets.length - unrouted.length) / opts.nets.length : 1,
    drcCritical: chosen.verify.metrics.drc_critical_count ?? 0,
    lengthNm,
    seconds: (Date.now() - t0) / 1000,
  };
  await writeFile(path.join(runDir, 'critical-nets.json'), JSON.stringify(result, null, 2), 'utf8');
  log(`critical-route: ${opts.nets.length - unrouted.length}/${opts.nets.length} critical net(s) routed in ${result.seconds.toFixed(1)} s${unrouted.length ? `; unrouted: ${unrouted.join(', ')}` : ''}`);
  return result;
}

/** The weight a class gives its nets, for callers deciding what counts as critical. */
export const classWeight = CLASS_WEIGHT;

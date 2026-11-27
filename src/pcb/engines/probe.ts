/**
 * Routability probe (implementation spec §5.3): route a placement candidate
 * with one router in a fixed configuration and report completion and DRC
 * errors as metrics, never as gates. Lives with the engines because it runs
 * one; the verify layer never imports it.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { routeBoard, type RouteOptions } from './route.js';
import type { EngineRegistry, EnginePolicy } from './registry.js';

export interface ProbeOptions {
  repoRoot: string;
  /** The materialized placement candidate. */
  pcbPath: string;
  workDir: string;
  routerId?: string;
  budgetSeconds?: number;
  registry?: EngineRegistry;
  policy?: EnginePolicy;
  noKicad?: boolean;
  /** Route only these nets, by name (add-reuse-placer: the critical-net probe). Default: every owed net. */
  netNames?: string[];
  log?: (line: string) => void;
}

export interface ProbeResult {
  routability_completion: number;
  /** Every error-severity DRC item on the probe-routed board. */
  routability_drc_errors: number;
  /** DRC items whose type is in the profile's critical list, errors and warnings alike (`drc_critical_count`). */
  routability_drc_critical: number;
  probe_engine?: string;
}

export const PROBE_STRATEGY = { passes: 10 } as const;

/** The routing options the probe runs: one router, the fixed strategy, seed 0, and the net subset when one is given. */
export function probeRouteOptions(opts: ProbeOptions): RouteOptions {
  const projectPath = opts.pcbPath.replace(/\.kicad_pcb$/, '.kicad_pro');
  return {
    repoRoot: opts.repoRoot,
    boardPath: opts.pcbPath,
    ...(existsSync(projectPath) ? { projectPath } : {}),
    runDir: path.join(opts.workDir, 'probe'),
    routers: [opts.routerId ?? 'router-freerouting'],
    mode: 'single',
    ...(opts.netNames ? { netNames: [...opts.netNames] } : {}),
    strategy: { ...PROBE_STRATEGY },
    seed: 0,
    limits: { engineSeconds: opts.budgetSeconds ?? 120, wallSeconds: opts.budgetSeconds ?? 120 },
    ...(opts.registry ? { registry: opts.registry } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.noKicad ? { noKicad: true } : {}),
    log: opts.log ?? (() => {}),
  };
}

export async function routabilityProbe(opts: ProbeOptions): Promise<ProbeResult> {
  const res = await routeBoard(probeRouteOptions(opts));
  const sel = res.ranking.selected ? res.candidates.find((c) => c.engineId === res.ranking.selected) : res.candidates[0];
  if (!sel) return { routability_completion: 0, routability_drc_errors: 0, routability_drc_critical: 0 };
  const m = sel.verify.metrics;
  return { routability_completion: m.completion_rate ?? 0, routability_drc_errors: m.drc_error_count ?? 0, routability_drc_critical: m.drc_critical_count ?? 0, probe_engine: sel.engineId };
}

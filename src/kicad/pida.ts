import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { loadConstraints, type ConstraintRegistry } from '../memory/constraints.js';
import type { Violation } from './report.js';

/**
 * DC power-integrity verification via Ki-PIDA (#176).
 *
 * Checks rail IR/voltage drop, current-density hotspots, thermal rise
 * hotspots, and multi-rail dependency chains against budgets declared in
 * `.copperhead/constraints.json`.
 */

export interface PowerBudgets {
  railDropMaxV: number | null;
  railDropByNetV: Record<string, number>;
  currentDensityMaxAmm2: number | null;
  tempRiseMaxC: number | null;
  sources: Record<string, string>;
}

export interface PidaRailMeasurement {
  rail: string;
  sinkRef: string;
  irDropV: number;
  x?: number;
  y?: number;
}

export interface PidaCurrentDensityHotspot {
  rail: string;
  layer: string;
  currentDensityAmm2: number;
  x?: number;
  y?: number;
}

export interface PidaThermalHotspot {
  ref: string;
  tempRiseC: number;
  x?: number;
  y?: number;
}

export interface PidaRailDependencyLink {
  rail: string;
  dependsOn: string;
  satisfied: boolean;
  reason?: string;
}

export interface PidaTelemetry {
  rails?: PidaRailMeasurement[];
  currentDensity?: PidaCurrentDensityHotspot[];
  thermal?: PidaThermalHotspot[];
  dependencies?: PidaRailDependencyLink[];
}

export interface PidaReport {
  ok: boolean;
  source: 'power-integrity';
  violations: Violation[];
  warnings: Violation[];
}

export type PidaRunner = (boardPath: string) => Promise<PidaTelemetry>;

function numericBudget(c: { max?: number; value?: string | number } | undefined): number | null {
  if (!c) return null;
  if (typeof c.max === 'number' && Number.isFinite(c.max)) return c.max;
  if (typeof c.value === 'number' && Number.isFinite(c.value)) return c.value;
  if (typeof c.value === 'string') {
    const parsed = Number.parseFloat(c.value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Extract DC power-integrity budgets from `.copperhead/constraints.json`.
 */
export function extractPowerBudgets(registry: ConstraintRegistry): PowerBudgets {
  const railDropByNetV: Record<string, number> = {};
  const sources: Record<string, string> = {};

  const globalDrop = numericBudget(registry['power.rail_drop_max_V']);
  if (globalDrop !== null) {
    sources['power.rail_drop_max_V'] = registry['power.rail_drop_max_V']!.source;
  }

  const currentDensityMaxAmm2 = numericBudget(registry['power.current_density_max_A_mm2']);
  if (currentDensityMaxAmm2 !== null) {
    sources['power.current_density_max_A_mm2'] = registry['power.current_density_max_A_mm2']!.source;
  }

  const tempRiseMaxC = numericBudget(registry['power.temp_rise_max_C']);
  if (tempRiseMaxC !== null) {
    sources['power.temp_rise_max_C'] = registry['power.temp_rise_max_C']!.source;
  }

  for (const [key, constraint] of Object.entries(registry)) {
    const m = /^power\.rails\.([A-Za-z0-9_+.-]+)\.drop_max_V$/.exec(key);
    if (!m) continue;
    const val = numericBudget(constraint);
    if (val !== null) {
      railDropByNetV[m[1]!] = val;
      sources[key] = constraint.source;
    }
  }

  return {
    railDropMaxV: globalDrop,
    railDropByNetV,
    currentDensityMaxAmm2,
    tempRiseMaxC,
    sources,
  };
}

function detectDependencyCycles(links: PidaRailDependencyLink[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const link of links) {
    const list = adj.get(link.rail) ?? [];
    list.push(link.dependsOn);
    adj.set(link.rail, list);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const cycles: string[][] = [];

  const dfs = (node: string, stack: string[]): void => {
    visiting.add(node);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (visiting.has(next)) {
        const idx = stack.indexOf(next);
        cycles.push([...stack.slice(idx), next]);
      } else if (!visited.has(next)) {
        dfs(next, stack);
      }
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of adj.keys()) {
    if (!visited.has(node)) dfs(node, []);
  }
  return cycles;
}

/**
 * Evaluate Ki-PIDA telemetry against constraints.json budgets.
 */
export function evaluatePowerIntegrity(telemetry: PidaTelemetry, budgets: PowerBudgets): PidaReport {
  const violations: Violation[] = [];
  const warnings: Violation[] = [];

  for (const r of telemetry.rails ?? []) {
    const netKey = `power.rails.${r.rail}.drop_max_V`;
    const budget = budgets.railDropByNetV[r.rail] ?? budgets.railDropMaxV;
    const budgetKey = budgets.railDropByNetV[r.rail] !== undefined ? netKey : 'power.rail_drop_max_V';
    if (budget === null || budget === undefined) continue;

    if (r.irDropV > budget) {
      violations.push({
        severity: 'error',
        type: 'ir_drop_exceeded',
        description: `${r.rail} rail - IR drop ${r.irDropV.toFixed(2)}V exceeds ${budget.toFixed(2)}V budget at ${r.sinkRef} (constraints.json: ${budgetKey})`,
        items: [
          {
            description: `${r.sinkRef} on ${r.rail}`,
            ...(r.x !== undefined ? { x: r.x } : {}),
            ...(r.y !== undefined ? { y: r.y } : {}),
          },
        ],
      });
    } else if (r.irDropV >= budget * 0.9) {
      warnings.push({
        severity: 'warning',
        type: 'ir_drop_near_budget',
        description: `${r.rail} rail - IR drop ${r.irDropV.toFixed(2)}V is within 10% of ${budget.toFixed(2)}V budget at ${r.sinkRef} (constraints.json: ${budgetKey})`,
        items: [
          {
            description: `${r.sinkRef} on ${r.rail}`,
            ...(r.x !== undefined ? { x: r.x } : {}),
            ...(r.y !== undefined ? { y: r.y } : {}),
          },
        ],
      });
    }
  }

  if (budgets.currentDensityMaxAmm2 !== null) {
    for (const cd of telemetry.currentDensity ?? []) {
      if (cd.currentDensityAmm2 > budgets.currentDensityMaxAmm2) {
        violations.push({
          severity: 'error',
          type: 'current_density_hotspot',
          description: `${cd.rail} rail on ${cd.layer} - current density ${cd.currentDensityAmm2.toFixed(1)}A/mm2 exceeds ${budgets.currentDensityMaxAmm2.toFixed(1)}A/mm2 budget (constraints.json: power.current_density_max_A_mm2)`,
          items: [
            {
              description: `${cd.rail} (${cd.layer})`,
              ...(cd.x !== undefined ? { x: cd.x } : {}),
              ...(cd.y !== undefined ? { y: cd.y } : {}),
            },
          ],
        });
      }
    }
  }

  if (budgets.tempRiseMaxC !== null) {
    for (const th of telemetry.thermal ?? []) {
      if (th.tempRiseC > budgets.tempRiseMaxC) {
        violations.push({
          severity: 'error',
          type: 'thermal_hotspot',
          description: `${th.ref} - temperature rise ${th.tempRiseC.toFixed(1)}C exceeds ${budgets.tempRiseMaxC.toFixed(1)}C budget (constraints.json: power.temp_rise_max_C)`,
          items: [
            {
              description: th.ref,
              ...(th.x !== undefined ? { x: th.x } : {}),
              ...(th.y !== undefined ? { y: th.y } : {}),
            },
          ],
        });
      }
    }
  }

  for (const dep of telemetry.dependencies ?? []) {
    if (!dep.satisfied) {
      violations.push({
        severity: 'error',
        type: 'rail_dependency_broken',
        description: `${dep.rail} rail dependency on ${dep.dependsOn} is broken${dep.reason ? `: ${dep.reason}` : ''}`,
        items: [{ description: `${dep.rail} -> ${dep.dependsOn}` }],
      });
    }
  }

  for (const cycle of detectDependencyCycles(telemetry.dependencies ?? [])) {
    violations.push({
      severity: 'error',
      type: 'rail_dependency_cycle',
      description: `circular power-rail dependency chain: ${cycle.join(' -> ')}`,
      items: [{ description: cycle.join(' -> ') }],
    });
  }

  return {
    ok: violations.length === 0,
    source: 'power-integrity',
    violations,
    warnings,
  };
}

/**
 * Format a DC power-integrity report for human CLI output.
 */
export function formatPowerIntegrity(report: PidaReport): string {
  if (report.ok && report.warnings.length === 0) {
    return 'power-integrity ✓';
  }
  const header = report.ok ? 'power-integrity ✓' : 'power-integrity ✗';
  const lines = [header];
  for (const v of report.violations) {
    lines.push(`Violation: ${v.description}`);
  }
  for (const w of report.warnings) {
    lines.push(`Warning: ${w.description}`);
  }
  const vWord = report.violations.length === 1 ? 'violation' : 'violations';
  const wWord = report.warnings.length === 1 ? 'warning' : 'warnings';
  lines.push(`${report.violations.length} ${vWord}, ${report.warnings.length} ${wWord}`);
  return lines.join('\n');
}

export async function defaultPidaRunner(boardPath: string): Promise<PidaTelemetry> {
  const bin = process.env.COPPERHEAD_KIPIDA_BIN?.trim() || 'ki-pida';
  const res = await execa(bin, ['--json', boardPath], { reject: false });
  if (res.failed) {
    throw new Error(res.stderr || res.stdout || `ki-pida exited ${res.exitCode}`);
  }
  return JSON.parse(String(res.stdout ?? '{}')) as PidaTelemetry;
}

/**
 * Run opt-in DC power-integrity verification on a KiCad board against
 * `.copperhead/constraints.json` budgets.
 */
export async function runPowerIntegrity(
  boardPath: string,
  repoRoot: string,
  runner: PidaRunner = defaultPidaRunner,
): Promise<PidaReport> {
  if (!existsSync(boardPath)) {
    throw new Error(`board file not found: ${boardPath}`);
  }
  const registry = await loadConstraints(repoRoot);
  const budgets = extractPowerBudgets(registry);
  const telemetry = await runner(boardPath);
  return evaluatePowerIntegrity(telemetry, budgets);
}

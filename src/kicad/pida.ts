import { execa } from 'execa';
import type { ConstraintRegistry } from '../memory/constraints.js';
import type { Violation } from './report.js';
import {
  defaultCheckerRegistry,
  evaluateWithChecker,
  formatCheckerReport,
  runChecker,
  type CheckerReport,
  type CheckerRunner,
  type VerificationChecker,
} from './checkers.js';

export const DEFAULT_KIPIDA_TIMEOUT_MS = 30_000;

export class PidaMissingError extends Error {
  constructor(
    message = 'ki-pida not found (set COPPERHEAD_KIPIDA_BIN or install an external DC power-integrity adapter)',
  ) {
    super(message);
    this.name = 'PidaMissingError';
  }
}

export class PidaToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PidaToolError';
  }
}

export interface PowerBudgets {
  railDropMaxV: number | null;
  railDropByNetV: Record<string, number>;
  currentDensityMaxAmm2: number | null;
  tempRiseMaxC: number | null;
  unparsedRailKeys?: string[];
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

export type PidaReport = CheckerReport<'power-integrity'>;

export type PidaRunner = CheckerRunner<PidaTelemetry>;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate raw Ki-PIDA telemetry JSON at the boundary so empty or schema-drifted
 * payloads fail closed instead of silently passing as `power-integrity ✓`.
 */
export function validatePidaTelemetry(raw: unknown): PidaTelemetry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PidaToolError('invalid ki-pida telemetry: expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const allowedTopKeys = new Set(['rails', 'currentDensity', 'thermal', 'dependencies']);
  for (const k of Object.keys(obj)) {
    if (!allowedTopKeys.has(k)) {
      throw new PidaToolError(`invalid ki-pida telemetry: unexpected top-level key "${k}"`);
    }
  }

  let totalEntries = 0;

  if (obj.rails !== undefined) {
    if (!Array.isArray(obj.rails)) {
      throw new PidaToolError('invalid ki-pida telemetry: "rails" must be an array');
    }
    for (const [i, item] of obj.rails.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new PidaToolError(`invalid ki-pida telemetry: rails[${i}] must be an object`);
      }
      const r = item as Record<string, unknown>;
      if (!isNonEmptyString(r.rail) || !isNonEmptyString(r.sinkRef) || !isFiniteNumber(r.irDropV)) {
        throw new PidaToolError(
          `invalid ki-pida telemetry: rails[${i}] requires string rail, string sinkRef, and finite number irDropV`,
        );
      }
      if ((r.x !== undefined && !isFiniteNumber(r.x)) || (r.y !== undefined && !isFiniteNumber(r.y))) {
        throw new PidaToolError(`invalid ki-pida telemetry: rails[${i}] x/y must be finite numbers`);
      }
      totalEntries++;
    }
  }

  if (obj.currentDensity !== undefined) {
    if (!Array.isArray(obj.currentDensity)) {
      throw new PidaToolError('invalid ki-pida telemetry: "currentDensity" must be an array');
    }
    for (const [i, item] of obj.currentDensity.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new PidaToolError(`invalid ki-pida telemetry: currentDensity[${i}] must be an object`);
      }
      const c = item as Record<string, unknown>;
      if (
        !isNonEmptyString(c.rail) ||
        !isNonEmptyString(c.layer) ||
        !isFiniteNumber(c.currentDensityAmm2)
      ) {
        throw new PidaToolError(
          `invalid ki-pida telemetry: currentDensity[${i}] requires string rail, string layer, and finite number currentDensityAmm2`,
        );
      }
      totalEntries++;
    }
  }

  if (obj.thermal !== undefined) {
    if (!Array.isArray(obj.thermal)) {
      throw new PidaToolError('invalid ki-pida telemetry: "thermal" must be an array');
    }
    for (const [i, item] of obj.thermal.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new PidaToolError(`invalid ki-pida telemetry: thermal[${i}] must be an object`);
      }
      const t = item as Record<string, unknown>;
      if (!isNonEmptyString(t.ref) || !isFiniteNumber(t.tempRiseC)) {
        throw new PidaToolError(
          `invalid ki-pida telemetry: thermal[${i}] requires string ref and finite number tempRiseC`,
        );
      }
      totalEntries++;
    }
  }

  if (obj.dependencies !== undefined) {
    if (!Array.isArray(obj.dependencies)) {
      throw new PidaToolError('invalid ki-pida telemetry: "dependencies" must be an array');
    }
    for (const [i, item] of obj.dependencies.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new PidaToolError(`invalid ki-pida telemetry: dependencies[${i}] must be an object`);
      }
      const d = item as Record<string, unknown>;
      if (
        !isNonEmptyString(d.rail) ||
        !isNonEmptyString(d.dependsOn) ||
        typeof d.satisfied !== 'boolean'
      ) {
        throw new PidaToolError(
          `invalid ki-pida telemetry: dependencies[${i}] requires string rail, string dependsOn, and boolean satisfied`,
        );
      }
      totalEntries++;
    }
  }

  if (totalEntries === 0) {
    throw new PidaToolError(
      'invalid ki-pida telemetry: payload holds no rail, currentDensity, thermal, or dependency measurements',
    );
  }

  return obj as PidaTelemetry;
}

function numericBudget(c: { max?: number; value?: string | number } | undefined): number | null {
  if (!c) return null;
  if (typeof c.max === 'number' && Number.isFinite(c.max)) return c.max;
  if (typeof c.value === 'number' && Number.isFinite(c.value)) return c.value;
  if (typeof c.value === 'string') {
    const trimmed = c.value.trim();
    const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Extract DC power-integrity budgets from `.copperhead/constraints.json`,
 * including hierarchical `/` net names (`power.rails./sub/3V3.drop_max_V`).
 */
export function extractPowerBudgets(registry: ConstraintRegistry): PowerBudgets {
  const railDropByNetV: Record<string, number> = {};
  const unparsedRailKeys: string[] = [];
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
    if (!key.startsWith('power.rails.')) continue;
    const m = /^power\.rails\.(.+)\.drop_max_V$/.exec(key);
    if (!m || !m[1]) {
      unparsedRailKeys.push(key);
      continue;
    }
    const val = numericBudget(constraint);
    if (val !== null) {
      railDropByNetV[m[1]] = val;
      sources[key] = constraint.source;
    } else {
      unparsedRailKeys.push(key);
    }
  }

  return {
    railDropMaxV: globalDrop,
    railDropByNetV,
    currentDensityMaxAmm2,
    tempRiseMaxC,
    ...(unparsedRailKeys.length ? { unparsedRailKeys } : {}),
    sources,
  };
}

function formatPairWithPrecision(measured: number, budget: number, minDecimals: number): [string, string] {
  for (let d = minDecimals; d <= 6; d++) {
    const mStr = measured.toFixed(d);
    const bStr = budget.toFixed(d);
    if (mStr !== bStr || measured === budget) {
      // Round-trip rule: never print the budget at a precision that changes
      // it. `0.155` rendered as `0.15` names a limit the user never set, and
      // the message then contradicts constraints.json.
      let bClean = String(budget);
      for (let e = minDecimals; e <= 6; e++) {
        const cand = budget.toFixed(e);
        if (Number(cand) === budget) {
          bClean = cand;
          break;
        }
      }
      return [mStr, bClean];
    }
  }
  return [String(measured), String(budget)];
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

export async function defaultPidaRunner(
  boardPath: string,
  opts?: { timeoutMs?: number },
): Promise<PidaTelemetry> {
  const bin = process.env.COPPERHEAD_KIPIDA_BIN?.trim() || 'ki-pida';
  const envTimeout = Number(process.env.COPPERHEAD_KIPIDA_TIMEOUT_MS ?? '');
  const timeoutMs =
    opts?.timeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_KIPIDA_TIMEOUT_MS);

  const res = await execa(bin, ['--json', boardPath], {
    reject: false,
    stdin: 'ignore',
    timeout: timeoutMs,
  });

  if (res.timedOut) {
    const secs = (timeoutMs / 1000).toFixed(timeoutMs >= 1000 ? 0 : 2);
    throw new PidaToolError(`ki-pida timed out after ${secs}s`);
  }
  const errCode = (res as { code?: string }).code;
  // Whether the user explicitly pinned a binary. A pinned path that cannot be
  // spawned is a configuration error, not an absent optional tool.
  const binWasPinned = Boolean(process.env.COPPERHEAD_KIPIDA_BIN?.trim());

  // --- terminated by a signal -------------------------------------------
  // execa documents `exitCode === undefined` for BOTH "could not be spawned"
  // and "terminated by a signal". Collapsing the two into PidaMissingError
  // made a segfaulting or OOM-killed solver read as "ki-pida not installed",
  // so `runCheck` turned it into `power.skipped` and `check --power` exited 0
  // - the exact fail-open this gate exists to prevent. A crash must fail
  // closed, so this is checked before anything else.
  const signalName = (res as { signal?: string }).signal;
  const isTerminated =
    Boolean((res as { isTerminated?: boolean }).isTerminated) || Boolean(signalName);
  if (isTerminated) {
    throw new PidaToolError(`ki-pida terminated by ${signalName || 'a signal'}`);
  }

  // --- genuinely not installed ------------------------------------------
  if (errCode === 'ENOENT') {
    if (binWasPinned) {
      throw new PidaToolError(
        `COPPERHEAD_KIPIDA_BIN points to a path that does not exist: ${bin}`,
      );
    }
    throw new PidaMissingError();
  }

  // Windows: cmd.exe reports an unknown command with this message and exit
  // code 1. Only treat it as "not installed" when the binary was not pinned,
  // so a typo in COPPERHEAD_KIPIDA_BIN can never silently skip the gate.
  if (
    !binWasPinned &&
    /not recognized as an internal or external command/i.test(String(res.stderr ?? ''))
  ) {
    throw new PidaMissingError();
  }

  // Could not be spawned for any other reason (EACCES, ENOEXEC, ...). Fail
  // closed rather than let the gate report itself as skipped.
  if (res.exitCode === undefined) {
    throw new PidaToolError(
      `ki-pida could not be spawned (${errCode ?? 'unknown error'})${
        binWasPinned ? `: ${bin}` : ''
      }`,
    );
  }

  if (res.failed) {
    throw new PidaToolError(
      String(res.stderr || res.stdout || `ki-pida exited ${res.exitCode}`).trim(),
    );
  }
  const stdout = String(res.stdout ?? '').trim();
  if (!stdout) {
    throw new PidaToolError('ki-pida produced empty stdout (expected JSON telemetry)');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const preview = stdout.slice(0, 200);
    throw new PidaToolError(
      `ki-pida returned invalid JSON: ${(err as Error).message} (stdout: ${preview})`,
    );
  }
  return validatePidaTelemetry(parsed);
}

/**
 * Pluggable `VerificationChecker` definition for Ki-PIDA DC power-integrity.
 */
export const powerIntegrityChecker: VerificationChecker<
  PidaTelemetry,
  PowerBudgets,
  'power-integrity'
> = {
  id: 'power-integrity',
  artifact: 'board',
  extractBudgets: extractPowerBudgets,
  defaultRunner: (boardPath: string) => defaultPidaRunner(boardPath),
  evaluate(rawTelemetry: PidaTelemetry, budgets: PowerBudgets) {
    const telemetry = validatePidaTelemetry(rawTelemetry);
    const violations: Violation[] = [];
    const warnings: Violation[] = [];

    for (const badKey of budgets.unparsedRailKeys ?? []) {
      warnings.push({
        severity: 'warning',
        type: 'unrecognized_rail_budget_key',
        description: `unrecognized or non-numeric rail budget key "${badKey}" (expected power.rails.<net>.drop_max_V with finite max/value)`,
        items: [],
      });
    }

    let uncheckedRails = 0;
    for (const r of telemetry.rails ?? []) {
      const netKey = `power.rails.${r.rail}.drop_max_V`;
      const budget = budgets.railDropByNetV[r.rail] ?? budgets.railDropMaxV;
      const budgetKey =
        budgets.railDropByNetV[r.rail] !== undefined ? netKey : 'power.rail_drop_max_V';
      if (budget === null || budget === undefined) {
        uncheckedRails++;
        continue;
      }

      if (r.irDropV > budget) {
        const [mStr, bStr] = formatPairWithPrecision(r.irDropV, budget, 2);
        violations.push({
          severity: 'error',
          type: 'ir_drop_exceeded',
          description: `${r.rail} rail - IR drop ${mStr}V exceeds ${bStr}V budget at ${r.sinkRef} (constraints.json: ${budgetKey})`,
          items: [
            {
              description: `${r.sinkRef} on ${r.rail}`,
              ...(r.x !== undefined ? { x: r.x } : {}),
              ...(r.y !== undefined ? { y: r.y } : {}),
            },
          ],
        });
      } else if (r.irDropV >= budget * 0.9) {
        const [mStr, bStr] = formatPairWithPrecision(r.irDropV, budget, 2);
        warnings.push({
          severity: 'warning',
          type: 'ir_drop_near_budget',
          description: `${r.rail} rail - IR drop ${mStr}V is within 10% of ${bStr}V budget at ${r.sinkRef} (constraints.json: ${budgetKey})`,
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
    if (uncheckedRails > 0) {
      warnings.push({
        severity: 'warning',
        type: 'power_budget_missing',
        description: `no power.rail_drop_max_V budget configured; ${uncheckedRails} rail measurement${uncheckedRails === 1 ? '' : 's'} unchecked`,
        items: [],
      });
    }

    if (budgets.currentDensityMaxAmm2 !== null) {
      for (const cd of telemetry.currentDensity ?? []) {
        if (cd.currentDensityAmm2 > budgets.currentDensityMaxAmm2) {
          const [mStr, bStr] = formatPairWithPrecision(
            cd.currentDensityAmm2,
            budgets.currentDensityMaxAmm2,
            1,
          );
          violations.push({
            severity: 'error',
            type: 'current_density_hotspot',
            description: `${cd.rail} rail on ${cd.layer} - current density ${mStr}A/mm2 exceeds ${bStr}A/mm2 budget (constraints.json: power.current_density_max_A_mm2)`,
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
    } else if ((telemetry.currentDensity?.length ?? 0) > 0) {
      const n = telemetry.currentDensity!.length;
      warnings.push({
        severity: 'warning',
        type: 'power_budget_missing',
        description: `no power.current_density_max_A_mm2 budget configured; ${n} current-density result${n === 1 ? '' : 's'} unchecked`,
        items: [],
      });
    }

    if (budgets.tempRiseMaxC !== null) {
      for (const th of telemetry.thermal ?? []) {
        if (th.tempRiseC > budgets.tempRiseMaxC) {
          const [mStr, bStr] = formatPairWithPrecision(th.tempRiseC, budgets.tempRiseMaxC, 1);
          violations.push({
            severity: 'error',
            type: 'thermal_hotspot',
            description: `${th.ref} - temperature rise ${mStr}C exceeds ${bStr}C budget (constraints.json: power.temp_rise_max_C)`,
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
    } else if ((telemetry.thermal?.length ?? 0) > 0) {
      const n = telemetry.thermal!.length;
      warnings.push({
        severity: 'warning',
        type: 'power_budget_missing',
        description: `no power.temp_rise_max_C budget configured; ${n} thermal result${n === 1 ? '' : 's'} unchecked`,
        items: [],
      });
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

    return { violations, warnings };
  },
};

if (!defaultCheckerRegistry.get('power-integrity')) {
  defaultCheckerRegistry.register(powerIntegrityChecker);
}

/**
 * Evaluate Ki-PIDA telemetry against constraints.json budgets.
 */
export function evaluatePowerIntegrity(telemetry: PidaTelemetry, budgets: PowerBudgets): PidaReport {
  return evaluateWithChecker(powerIntegrityChecker, telemetry, budgets);
}

/**
 * Format a DC power-integrity report for human CLI output.
 */
export function formatPowerIntegrity(report: PidaReport): string {
  return formatCheckerReport(report);
}

/**
 * Run opt-in DC power-integrity verification on a KiCad board against
 * `.copperhead/constraints.json` budgets.
 */
export async function runPowerIntegrity(
  boardPath: string,
  repoRoot: string,
  runner: PidaRunner = powerIntegrityChecker.defaultRunner,
): Promise<PidaReport> {
  return runChecker(powerIntegrityChecker, boardPath, repoRoot, runner);
}

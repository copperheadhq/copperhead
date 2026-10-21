import { existsSync } from 'node:fs';
import { loadConstraints, type ConstraintRegistry } from '../memory/constraints.js';
import type { Violation } from './report.js';

/**
 * Pluggable framework for opt-in external verification checkers
 * (Ki-PIDA DC power integrity, ngspice analog simulation, openEMS EMC, etc.).
 *
 * Each checker declares:
 * - which artifact it inspects (`schematic` or `board`),
 * - how it extracts budgets from `.copperhead/constraints.json`,
 * - how it invokes its external tool (or injected test runner) to collect telemetry, and
 * - how it evaluates that telemetry into normalized `Violation` entries.
 *
 * File-existence checks, constraint loading, report construction, and CLI
 * formatting live once in this module rather than being duplicated per checker.
 */

export type CheckerArtifact = 'schematic' | 'board';

export interface CheckerEvaluation {
  violations: Violation[];
  warnings?: Violation[];
}

export interface CheckerReport<TId extends string = string> {
  ok: boolean;
  source: TId;
  violations: Violation[];
  warnings: Violation[];
}

export type CheckerRunner<TTelemetry> = (artifactPath: string) => Promise<TTelemetry>;

export interface VerificationChecker<
  TTelemetry,
  TBudgets,
  TId extends string = string,
> {
  readonly id: TId;
  readonly artifact: CheckerArtifact;
  extractBudgets(registry: ConstraintRegistry): TBudgets;
  defaultRunner: CheckerRunner<TTelemetry>;
  evaluate(telemetry: TTelemetry, budgets: TBudgets): CheckerEvaluation;
}

/**
 * Evaluate telemetry against budgets using a checker definition and return a
 * normalized `CheckerReport`.
 */
export function evaluateWithChecker<TTelemetry, TBudgets, TId extends string>(
  checker: VerificationChecker<TTelemetry, TBudgets, TId>,
  telemetry: TTelemetry,
  budgets: TBudgets,
): CheckerReport<TId> {
  const { violations, warnings = [] } = checker.evaluate(telemetry, budgets);
  return {
    ok: violations.length === 0,
    source: checker.id,
    violations,
    warnings,
  };
}

/**
 * Format any `CheckerReport` in the standard Copperhead verification voice:
 * `<source> ✓` / `<source> ✗`, per-violation and per-warning lines, and a
 * summary count line.
 */
export function formatCheckerReport(report: CheckerReport): string {
  if (report.ok && report.warnings.length === 0) {
    return `${report.source} ✓`;
  }
  const header = report.ok ? `${report.source} ✓` : `${report.source} ✗`;
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

/**
 * Run a `VerificationChecker` against an artifact file and the repo's
 * `.copperhead/constraints.json`.
 */
export async function runChecker<TTelemetry, TBudgets, TId extends string>(
  checker: VerificationChecker<TTelemetry, TBudgets, TId>,
  artifactPath: string,
  repoRoot: string,
  runner: CheckerRunner<TTelemetry> = checker.defaultRunner,
): Promise<CheckerReport<TId>> {
  if (!existsSync(artifactPath)) {
    throw new Error(`${checker.artifact} file not found: ${artifactPath}`);
  }
  const registry = await loadConstraints(repoRoot);
  const budgets = checker.extractBudgets(registry);
  const telemetry = await runner(artifactPath);
  return evaluateWithChecker(checker, telemetry, budgets);
}

/**
 * Registry of opt-in external verification checkers keyed by `checker.id`.
 */
export class CheckerRegistry {
  private readonly checkers = new Map<string, VerificationChecker<unknown, unknown, string>>();

  register<TTelemetry, TBudgets, TId extends string>(
    checker: VerificationChecker<TTelemetry, TBudgets, TId>,
  ): this {
    if (this.checkers.has(checker.id)) {
      throw new Error(`checker "${checker.id}" is already registered`);
    }
    this.checkers.set(
      checker.id,
      checker as unknown as VerificationChecker<unknown, unknown, string>,
    );
    return this;
  }

  get<TTelemetry = unknown, TBudgets = unknown, TId extends string = string>(
    id: TId,
  ): VerificationChecker<TTelemetry, TBudgets, TId> | undefined {
    return this.checkers.get(id) as
      | VerificationChecker<TTelemetry, TBudgets, TId>
      | undefined;
  }

  list(): string[] {
    return [...this.checkers.keys()];
  }

  async run<TTelemetry = unknown, TId extends string = string>(
    id: TId,
    artifactPath: string,
    repoRoot: string,
    runner?: CheckerRunner<TTelemetry>,
  ): Promise<CheckerReport<TId>> {
    const checker = this.get<TTelemetry, unknown, TId>(id);
    if (!checker) {
      throw new Error(
        `unknown verification checker "${id}" (registered: ${this.list().join(', ') || 'none'})`,
      );
    }
    return runChecker(checker, artifactPath, repoRoot, runner);
  }
}

export function createCheckerRegistry(): CheckerRegistry {
  return new CheckerRegistry();
}

export const defaultCheckerRegistry = createCheckerRegistry();

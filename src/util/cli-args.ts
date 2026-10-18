/**
 * Pure argument helpers for the CLI surface. They live here rather than in
 * cli.ts because that module wires up commander and parses argv at import
 * time, which makes it untestable in-process: importing it runs the program.
 * Anything with a branch worth pinning belongs on this side of the line.
 */

import path from 'node:path';
import type { BudgetExhaustedStats } from '../agent/loop.js';
import type { Provider } from '../agent/types.js';
import { type CompatSettings, type CopperheadConfig, resolveCompatSettings } from '../config.js';

/** Resolve `--repo` against the working directory; absolute paths pass through. */
export function repoOf(opts: { repo?: string }): string {
  return path.resolve(opts.repo ?? process.cwd());
}

/** `--max-turns` accepts only a positive integer; "5oops" and "NaN" refuse to start. */
export function parseMaxTurns(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--max-turns must be a positive integer, got "${raw}"`);
  }
  return n;
}

/**
 * Turns offered when the budget runs out: ceil of the ORIGINAL budget (design
 * D1), so repeat extensions offer the same increment instead of escalating
 * with the already-extended turn count.
 */
export function budgetExtraTurns(stats: Pick<BudgetExhaustedStats, 'maxTurns'>): number {
  return Math.ceil(stats.maxTurns / 2);
}

/** The attended "continue?" question, with the cost of the run so far spelled out. */
export function budgetPromptText(stats: BudgetExhaustedStats): string {
  const k = (n: number): string => `${(n / 1000).toFixed(1)}k`;
  return (
    `Turn budget exhausted (${stats.turnsUsed} turns, ${k(stats.tokensIn)} in / ${k(stats.tokensOut)} out, ` +
    `${stats.filesTouched.length} file(s) touched, ${stats.openObligations} open obligation(s)). ` +
    `Continue with ${budgetExtraTurns(stats)} more turns?`
  );
}

/**
 * The provider factory `copperhead review` hands its passes: one resumed provider session per pass
 * (only the new messages are sent each turn), and a `compat:<id>` model's endpoint and key variable
 * resolved from the environment and the design's config, as every other entry point does.
 */
export function reviewProviderFactory(
  config: CopperheadConfig,
  make: (model: string, sessionResume: boolean, compat: CompatSettings) => Promise<Provider>,
  env = process.env,
): (model: string) => Promise<Provider> {
  const compat = resolveCompatSettings(config, env);
  return (model) => make(model, true, compat);
}

import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { redactSecrets } from '../util/redact.js';
import type { RunResult } from '../agent/loop.js';
import type { RefusalBlocker } from '../agent/context.js';
import type { ConstraintRegistry } from '../memory/constraints.js';

/**
 * Why a stage attempt did not complete the stage (design D2). A pure function of
 * the run result, so the retry policy is testable without a provider: a verified
 * constraint conflict stops the stage for a human, a spent turn budget retries
 * with more turns, everything else goes to the recovery supervisor as before.
 */
export type AttemptCause = 'constraint-conflict' | 'turn-budget-exhausted' | 'other';

export function classifyAttempt(res: Pick<RunResult, 'outcome' | 'exitPath' | 'blockers'>): AttemptCause {
  if (res.outcome === 'refused' && (res.blockers?.length ?? 0) > 0) return 'constraint-conflict';
  if (res.exitPath === 'turn-budget-exhausted') return 'turn-budget-exhausted';
  return 'other';
}

/**
 * The next attempt's turn budget after an exhaustion (design D3): 1.5× the
 * previous attempt's, rounded up, never above 3× the stage's starting budget.
 * 40 → 60 → 90 → 120, then 120 for good.
 */
export function nextBudget(prev: number, start: number): number {
  return Math.min(Math.ceil(prev * 1.5), start * 3);
}

/**
 * Stages whose mutations are docs, `openspec/` and the constraint registry, never
 * KiCad files. A retry of one of these resumes from the previous attempt's
 * preserved draft (design D5); KiCad-touching stages keep the plain rollback.
 */
export const DOCS_ONLY_STAGES = ['spec-seed', 'architecture', 'part-selection'] as const;

export function isDocsOnlyStage(name: string): boolean {
  return (DOCS_ONLY_STAGES as readonly string[]).includes(name);
}

/**
 * The decision block a verified constraint conflict prints and writes (design
 * D4): per blocker the key, the required value, the failing candidate, the
 * attempt and the document the constraint was recorded from; the two ways
 * forward; and how to resume. No absolute path, no stack trace.
 */
export function renderDecisionStop(input: {
  stage: string;
  attempt: number;
  blockers: RefusalBlocker[];
  registry: ConstraintRegistry;
}): { terminal: string; markdown: string } {
  // Own properties only: a key such as "constructor" is not a registered constraint.
  const sourceOf = (key: string): string | undefined =>
    Object.hasOwn(input.registry, key) ? input.registry[key]?.source : undefined;
  const items = input.blockers.map((b) => {
    const source = sourceOf(b.constraint);
    return {
      head: `${b.constraint}: required ${b.required}; found ${b.found}`,
      tail: `attempt ${input.attempt}${source ? `; recorded from ${source}` : ''}`,
    };
  });
  const sources = [...new Set(input.blockers.map((b) => sourceOf(b.constraint)).filter(Boolean))];
  const where = sources.length ? ` (${sources.join(', ')})` : '';
  const routes = [
    `Revise the constraint where it is recorded${where} and in .copperhead/constraints.json, if the requirement is wrong.`,
    'Name a compliant part in the brief or docs/SUBSYSTEMS.md, if the requirement stands.',
  ];
  const resume = `Re-running \`copperhead create\` resumes at ${input.stage}.`;
  const terminal = [
    `Decision needed: ${input.stage} cannot satisfy a recorded constraint.`,
    ...items.map((i) => `  - ${i.head} (${i.tail})`),
    'Two ways forward:',
    ...routes.map((r, i) => `  ${i + 1}. ${r}`),
    resume,
  ].join('\n');
  const markdown = [
    '## Decision needed',
    '',
    `${input.stage} cannot satisfy a recorded constraint:`,
    '',
    ...items.map((i) => `- **${i.head}** (${i.tail})`),
    '',
    'Two ways forward:',
    '',
    ...routes.map((r, i) => `${i + 1}. ${r}`),
    '',
    resume,
  ].join('\n');
  return { terminal, markdown };
}

/**
 * Record, in the attempt's own `summary.md`, how the pipeline classified the
 * attempt and what it did next (AC-18.6), plus any block the stop rendered.
 * Best-effort: a scripted run with no transcript dir, or a missing summary,
 * records nothing and never throws.
 */
export async function appendSummaryNote(transcriptDir: string, lines: string[], extraMarkdown?: string): Promise<void> {
  if (!transcriptDir) return;
  const file = path.join(transcriptDir, 'summary.md');
  if (!existsSync(file)) return;
  const body = ['', '## Pipeline', '', ...lines.map((l) => `- ${l}`), ...(extraMarkdown ? ['', extraMarkdown] : []), ''].join('\n');
  try {
    // Blocker fields and the supervisor's reason are free text from a model, so
    // this write redacts like every other summary and transcript write (AC-4.1).
    await appendFile(file, redactSecrets(body), 'utf8');
  } catch {
    // telemetry must never break a run
  }
}

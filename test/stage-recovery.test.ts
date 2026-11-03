import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import type { RefusalBlocker } from '../src/agent/context.js';
import { classifyAttempt, nextBudget, renderDecisionStop, isDocsOnlyStage } from '../src/commands/stage-recovery.js';
import { applyFailedRun, preserveFailedRun, snapshot, restore } from '../src/util/git.js';
import { saveConstraint } from '../src/memory/constraints.js';
import { tempFixtureRepo } from './helpers.js';

const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockDiagnose = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  diagnoseStageFailure: mockDiagnose,
  transcriptExcerpt: async () => '',
}));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));

import { runCreate, STAGES } from '../src/commands/create.js';

const blocker: RefusalBlocker = {
  kind: 'constraint-conflict',
  constraint: 'protection.precharge_bypass',
  required: '≥ 16 A',
  found: 'G5Q-1A4 relay, 6 A',
};

function ok(over: Partial<RunResult> = {}): RunResult {
  return {
    outcome: 'success',
    exitPath: 'done',
    summary: 'mock',
    transcriptDir: '',
    filesTouched: [],
    commit: null,
    stats: { exitPath: 'done', turnsUsed: 3, maxTurns: 40, repairCyclesUsed: 0, maxRepairCycles: 5, tokensIn: 100, tokensOut: 20, perTurn: [], durationMs: 10 },
    cacheHits: 0,
    ...over,
  };
}
const exhausted = (over: Partial<RunResult> = {}): RunResult =>
  ok({ outcome: 'failure', exitPath: 'turn-budget-exhausted', summary: 'turn budget exhausted', stats: { ...ok().stats, exitPath: 'turn-budget-exhausted' }, ...over });
const providerError = (): RunResult => ok({ outcome: 'failure', exitPath: 'provider-error', summary: 'boom' });
const refused = (blockers: RefusalBlocker[], over: Partial<RunResult> = {}): RunResult =>
  ok({ outcome: 'refused', exitPath: 'refused', summary: 'cannot satisfy it', blockers, ...over });

async function writeStageDoc(repoRoot: string, request: string): Promise<void> {
  const docs = path.join(repoRoot, 'docs');
  await mkdir(docs, { recursive: true });
  if (request.includes('spec-seed')) await writeFile(path.join(docs, 'SPEC.md'), '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
  else if (request.includes('architecture')) await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# s\n\n## Power\n\nLDO regulator.\n', 'utf8');
  else if (request.includes('part-selection'))
    await writeFile(
      path.join(docs, 'BOM.md'),
      '# b\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | bias |\n',
      'utf8',
    );
}

/** A run dir with a summary.md, so the pipeline's note has somewhere to go. */
async function runDir(repo: string, id: string): Promise<string> {
  const dir = path.join(repo, '.copperhead', 'runs', id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'summary.md'), '# Run summary\n', 'utf8');
  return dir;
}

let prevKey: string | undefined;
beforeEach(() => {
  mockRunAgentLoop.mockReset();
  mockDiagnose.mockReset();
  mockDiagnose.mockResolvedValue({ verdict: 'abort', reason: 'default: stop' });
  prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-dummy';
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
});

async function seedRepo(repo: string, config: Record<string, unknown> = {}): Promise<string> {
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify(config), 'utf8');
  const briefPath = path.join(repo, 'brief.md');
  await writeFile(briefPath, '# tiny\n', 'utf8');
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-qm', 'seed'], { cwd: repo });
  return briefPath;
}

describe('attempt classification and escalation (design D2, D3)', () => {
  it('classifies a verified conflict, a spent budget, and everything else', () => {
    expect(classifyAttempt(refused([blocker]))).toBe('constraint-conflict');
    expect(classifyAttempt(refused([]))).toBe('other'); // an unverified claim is prose
    expect(classifyAttempt(exhausted())).toBe('turn-budget-exhausted');
    expect(classifyAttempt(providerError())).toBe('other');
    expect(classifyAttempt(ok())).toBe('other'); // a successful run with its contract unmet
  });

  it('escalates 40 → 60 → 90 → 120 and holds at the 3× cap (AC-18.9)', () => {
    let b = 40;
    const seen = [b];
    for (let i = 0; i < 4; i++) {
      b = nextBudget(b, 40);
      seen.push(b);
    }
    expect(seen).toEqual([40, 60, 90, 120, 120]);
    expect(nextBudget(7, 7)).toBe(11); // rounded up
  });

  it('knows which stages are docs-only', () => {
    expect(['spec-seed', 'architecture', 'part-selection'].every(isDocsOnlyStage)).toBe(true);
    expect(['schematic', 'layout-draft', 'outputs'].some(isDocsOnlyStage)).toBe(false);
  });

  it('renders the decision block with key, required, found, attempt, source and the two routes (design D4)', () => {
    const { terminal, markdown } = renderDecisionStop({
      stage: 'part-selection',
      attempt: 1,
      blockers: [blocker],
      registry: { 'protection.precharge_bypass': { min: 16, source: 'docs/SPEC.md', affects: [] } },
    });
    for (const text of [terminal, markdown]) {
      expect(text).toContain('protection.precharge_bypass: required ≥ 16 A; found G5Q-1A4 relay, 6 A');
      expect(text).toContain('attempt 1; recorded from docs/SPEC.md');
      expect(text).toContain('Revise the constraint where it is recorded (docs/SPEC.md)');
      expect(text).toContain('Name a compliant part in the brief or docs/SUBSYSTEMS.md');
      expect(text).toContain('Re-running `copperhead create` resumes at part-selection.');
      expect(text).not.toMatch(/\/home\/|\/tmp\//);
    }
    expect(markdown.startsWith('## Decision needed')).toBe(true);
  });

  it('the part-selection prompt tells the agent to refuse with blockers (task 4.3)', () => {
    const prompt = STAGES.find((s) => s.name === 'part-selection')!.prompt('# brief', 'docs/');
    expect(prompt).toContain('outcome "refuse"');
    expect(prompt).toContain('"kind": "constraint-conflict"');
    expect(prompt).toContain('stops for a human decision');
  });
});

describe('create retries by cause (AC-18.6 .. AC-18.10)', () => {
  it('a verified conflict stops the stage: no second attempt, no diagnosis, the block printed and written (AC-18.7)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      await saveConstraint(repo, 'protection.precharge_bypass', { min: 16, source: 'docs/SPEC.md', affects: [] });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-qm', 'constraint'], { cwd: repo });
      const dir = await runDir(repo, 'ps-1');
      let partAttempts = 0;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('part-selection')) {
          partAttempts++;
          return refused([blocker], { transcriptDir: dir });
        }
        await writeStageDoc(opts.repoRoot, opts.request);
        return ok();
      });
      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['spec-seed', 'architecture']);
      expect(res.stop).toEqual({ stage: 'part-selection', cause: 'constraint-conflict', blockers: [blocker] });
      expect(partAttempts).toBe(1);
      expect(mockDiagnose).not.toHaveBeenCalled();

      const out = lines.join('\n');
      expect(out).toContain('attempt 1 ended: constraint-conflict');
      expect(out).toContain('Decision needed: part-selection cannot satisfy a recorded constraint.');
      expect(out).toContain('protection.precharge_bypass: required ≥ 16 A; found G5Q-1A4 relay, 6 A (attempt 1; recorded from docs/SPEC.md)');
      expect(out).toContain('resumes at part-selection');

      const summary = await readFile(path.join(dir, 'summary.md'), 'utf8');
      expect(summary).toContain('- cause: constraint-conflict');
      expect(summary).toContain('- action: stopped for a decision');
      expect(summary).toContain('## Decision needed');
    } finally {
      await cleanup();
    }
  });

  it('an unverified claim is "other": the supervisor is consulted and decides (AC-18.8)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      let partAttempts = 0;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('part-selection')) {
          partAttempts++;
          if (partAttempts === 1) return refused([]); // the key was not registered: no verified blocker
        }
        await writeStageDoc(opts.repoRoot, opts.request);
        return ok();
      });
      mockDiagnose.mockResolvedValueOnce({ verdict: 'retry', reason: 'claim unverified', guidance: 'look again' });
      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      const partDiagnoses = mockDiagnose.mock.calls.filter(([, input]) => (input as { stageName: string }).stageName === 'part-selection');
      expect(partDiagnoses).toHaveLength(1);
      expect(partAttempts).toBe(2);
      expect(res.completed).toContain('part-selection');
      expect(lines.join('\n')).toContain('attempt 1 ended: other');
    } finally {
      await cleanup();
    }
  });

  it('a spent budget retries with 1.5× the turns, capped at 3×, while other causes keep the budget (AC-18.9, AC-18.10)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo, { maxStageRetries: 3, stageMaxTurns: { 'spec-seed': 40 } });
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('spec-seed')) return exhausted();
        return ok();
      });
      mockDiagnose.mockResolvedValue({ verdict: 'retry', reason: 'needs more turns', guidance: 'keep going' });
      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      expect(res.ok).toBe(false);
      const budgets = mockRunAgentLoop.mock.calls.map(([o]) => o.maxTurns);
      expect(budgets).toEqual([40, 60, 90, 120]);
      expect(mockDiagnose).toHaveBeenCalledTimes(3); // still consulted for guidance on every retry
      const out = lines.join('\n');
      expect(out).toContain('retry with 60 turns (escalated from 40');
      expect(out).toContain('running (attempt 2/4, 60 turns)');
      expect(out).toContain('exhausted 3 auto-retry(ies)');
    } finally {
      await cleanup();
    }
  });

  it('a provider error keeps the previous budget on retry (AC-18.10)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      let specAttempts = 0;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('spec-seed') && ++specAttempts === 1) return providerError();
        await writeStageDoc(opts.repoRoot, opts.request);
        return ok();
      });
      mockDiagnose.mockResolvedValueOnce({ verdict: 'retry', reason: 'transient' });
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      const spec = mockRunAgentLoop.mock.calls.map(([o]) => o).filter((o) => o.request.includes('spec-seed'));
      expect(spec).toHaveLength(2);
      expect(spec[1]!.maxTurns).toBe(spec[0]!.maxTurns);
    } finally {
      await cleanup();
    }
  });

  it('logs start, cause and action for every attempt, in that order (AC-18.6)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      const dir = await runDir(repo, 'ps-2');
      let partAttempts = 0;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('part-selection')) {
          partAttempts++;
          if (partAttempts <= 2) return exhausted({ transcriptDir: dir });
        }
        await writeStageDoc(opts.repoRoot, opts.request);
        return ok();
      });
      mockDiagnose.mockResolvedValue({ verdict: 'retry', reason: 'more turns', guidance: 'go' });
      const lines: string[] = [];
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      const idx = (needle: string): number => lines.findIndex((l) => l.includes(needle));
      const start = idx('running (attempt 2/3');
      const cause = lines.findIndex((l, i) => i > start && l.includes('attempt 2 ended: turn-budget-exhausted'));
      const action = lines.findIndex((l, i) => i > cause && l.includes('retry with 90 turns (escalated from 60'));
      expect(start).toBeGreaterThan(-1);
      expect(cause).toBeGreaterThan(start);
      expect(action).toBeGreaterThan(cause);
      const summary = await readFile(path.join(dir, 'summary.md'), 'utf8');
      expect(summary).toContain('- cause: turn-budget-exhausted');
      expect(summary).toContain('- action: retry with');
    } finally {
      await cleanup();
    }
  });
});

describe('applyFailedRun (task 4.1)', () => {
  it('applies a preserved run, names its files, and drops the entry', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const original = await readFile(sch, 'utf8');
      const snap = await snapshot(repo);
      await writeFile(sch, original.replace('KEY_DAH', 'KEY_EDITED'), 'utf8');
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'BOM.md'), 'draft\n', 'utf8');
      expect(await preserveFailedRun(repo, 'r1')).toBeTruthy();
      await restore(repo, snap);
      expect(existsSync(path.join(repo, 'docs', 'BOM.md'))).toBe(false);

      const applied = await applyFailedRun(repo, 'r1');
      expect(applied.ok).toBe(true);
      // .gitignore rides along: preserveFailedRun appends `.history/` to it before stashing.
      expect(applied.files.filter((f) => f !== '.gitignore').sort()).toEqual(['docs/BOM.md', 'hardware/open-key.kicad_sch']);
      expect(await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8')).toBe('draft\n');
      expect(await readFile(sch, 'utf8')).toContain('KEY_EDITED');
      const { stdout } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stdout).toBe('');
    } finally {
      await cleanup();
    }
  });

  it('a conflicting entry is kept and reported, and the tree is left as it was', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const original = await readFile(sch, 'utf8');
      const snap = await snapshot(repo);
      await writeFile(sch, original.replace('KEY_DAH', 'KEY_EDITED'), 'utf8');
      expect(await preserveFailedRun(repo, 'r2')).toBeTruthy();
      await restore(repo, snap);
      // Meanwhile the same line changed on the tree, and was committed.
      await writeFile(sch, original.replace('KEY_DAH', 'KEY_OTHER'), 'utf8');
      await execa('git', ['commit', '-qam', 'diverge'], { cwd: repo });

      const applied = await applyFailedRun(repo, 'r2');
      expect(applied.ok).toBe(false);
      if (!applied.ok) expect(applied.error).toContain('did not apply cleanly');
      expect(await readFile(sch, 'utf8')).toContain('KEY_OTHER');
      expect(await readFile(sch, 'utf8')).not.toContain('<<<<<<<');
      const { stdout } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stdout).toContain('copperhead failed run r2');
    } finally {
      await cleanup();
    }
  });

  it('no entry for the run is not an error', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await applyFailedRun(repo, 'nope')).toEqual({ ok: true, files: [] });
    } finally {
      await cleanup();
    }
  });
});

describe('docs-only stages resume from the preserved draft (AC-18.11, AC-18.12)', () => {
  /** What the real loop does on a failed attempt: preserve the work, then roll back to its pre-run snapshot. */
  async function failLikeTheLoop(repo: string, runId: string, snap: Awaited<ReturnType<typeof snapshot>>): Promise<string> {
    await preserveFailedRun(repo, runId);
    await restore(repo, snap);
    return path.join(repo, '.copperhead', 'runs', runId);
  }

  it('part selection retries with the first attempt\'s BOM draft on the tree and named in the guidance', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      await runDir(repo, 'ps-a1');
      let partAttempts = 0;
      let draftSeenOnRetry: string | null = null;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('part-selection')) {
          partAttempts++;
          if (partAttempts === 1) {
            const snap = await snapshot(repo);
            await mkdir(path.join(repo, 'docs'), { recursive: true });
            await writeFile(path.join(repo, 'docs', 'BOM.md'), '# draft from attempt 1\n', 'utf8');
            const dir = await failLikeTheLoop(repo, 'ps-a1', snap);
            return exhausted({ transcriptDir: dir });
          }
          draftSeenOnRetry = await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8').catch(() => null);
          expect(opts.stagePrompt).toMatch(/Restored from the previous attempt: [^\n]*docs\/BOM\.md/);
          expect(opts.stagePrompt).not.toContain('docs/SPEC.md,'); // untouched earlier-stage docs are not "restored"
        }
        await writeStageDoc(opts.repoRoot, opts.request);
        return ok();
      });
      mockDiagnose.mockResolvedValueOnce({ verdict: 'retry', reason: 'more turns', guidance: 'continue' });
      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      expect(partAttempts).toBe(2);
      expect(draftSeenOnRetry).toBe('# draft from attempt 1\n');
      expect(res.completed).toContain('part-selection');
      expect(lines.join('\n')).toMatch(/restored the previous attempt's draft: [^\n]*docs\/BOM\.md/);
      const { stdout } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stdout).not.toContain('ps-a1'); // applied and dropped
    } finally {
      await cleanup();
    }
  });

  it('a KiCad stage retry starts from the pre-stage tree, with the failed work only in the stash (AC-18.12)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      await runDir(repo, 'sch-a1');
      let schAttempts = 0;
      let noteOnRetry = true;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('schematic')) {
          schAttempts++;
          if (schAttempts === 1) {
            const snap = await snapshot(repo);
            await writeFile(path.join(repo, 'docs', 'NOTE.md'), 'from the failed schematic attempt\n', 'utf8');
            const dir = await failLikeTheLoop(repo, 'sch-a1', snap);
            return exhausted({ transcriptDir: dir });
          }
          noteOnRetry = existsSync(path.join(repo, 'docs', 'NOTE.md'));
          return providerError();
        }
        await writeStageDoc(opts.repoRoot, opts.request);
        return ok();
      });
      mockDiagnose.mockResolvedValueOnce({ verdict: 'retry', reason: 'more turns', guidance: 'continue' });
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      expect(res.ok).toBe(false);
      expect(schAttempts).toBe(2);
      expect(noteOnRetry).toBe(false);
      const { stdout } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stdout).toContain('copperhead failed run sch-a1');
    } finally {
      await cleanup();
    }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Covers the review's F3 gap: the retry / resume-commit branches of runCreate
// were essentially untested. These drive them with a scripted runAgentLoop and a
// scripted recovery diagnosis, no live provider.
const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockDiagnose = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Deterministic diagnosis; each test sets the verdict it wants.
  diagnoseStageFailure: mockDiagnose,
  transcriptExcerpt: async () => '',
}));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));

import { runCreate } from '../src/commands/create.js';

/** A successful mocked run result (one attempt worth of stats). */
function ok(): RunResult {
  return {
    outcome: 'success',
    exitPath: 'done',
    summary: 'mock',
    transcriptDir: '',
    filesTouched: [],
    commit: null,
    stats: {
      exitPath: 'done',
      turnsUsed: 3,
      maxTurns: 40,
      repairCyclesUsed: 0,
      maxRepairCycles: 5,
      tokensIn: 1000,
      tokensOut: 200,
      perTurn: [],
      durationMs: 1000,
    },
    cacheHits: 0,
  };
}

/** Write the doc that satisfies a given doc-stage's completion contract. */
async function writeStageDoc(repoRoot: string, request: string): Promise<void> {
  const docs = path.join(repoRoot, 'docs');
  await mkdir(docs, { recursive: true });
  if (request.includes('spec-seed'))
    await writeFile(path.join(docs, 'SPEC.md'), '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
  else if (request.includes('architecture'))
    await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# s\n\n## Power\n\nLDO regulator.\n', 'utf8');
  else if (request.includes('part-selection'))
    await writeFile(
      path.join(docs, 'BOM.md'),
      '# b\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | RC0603FR-0710KL | bias |\n',
      'utf8',
    );
}

// diagnose() constructs a provider (via makeProvider) before the mocked
// diagnoseStageFailure runs; a dummy key keeps that construction from throwing.
// The provider is never actually called, so no network access occurs.
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

/** The pipeline scaffolds a KiCad project at the schematic stage, which writes
 *  `.copperhead/config.json`; create the dir so that write does not ENOENT. */
async function seedRepo(repo: string): Promise<string> {
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  const briefPath = path.join(repo, 'brief.md');
  await writeFile(briefPath, '# tiny\n', 'utf8');
  return briefPath;
}

describe('create pipeline resilience (review F3)', () => {
  it('a retry verdict drives a successful second attempt, prepends the guidance, and accumulates cost across attempts', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);

      let specSeedCalls = 0;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('spec-seed')) {
          specSeedCalls++;
          // Attempt 1 produces no SPEC.md (contract unmet); attempt 2 does.
          if (specSeedCalls >= 2) await writeStageDoc(opts.repoRoot, opts.request);
        } else {
          await writeStageDoc(opts.repoRoot, opts.request);
        }
        return ok();
      });
      // First failure gets a retry with concrete guidance + real token usage.
      mockDiagnose.mockResolvedValueOnce({
        verdict: 'retry',
        reason: 'transient',
        guidance: 'GUIDANCE-MARKER-XYZ',
        usage: { inputTokens: 40, outputTokens: 10 },
      });

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      // The stage was retried once and then completed.
      expect(specSeedCalls).toBe(2);
      expect(res.completed).toContain('spec-seed');
      const briefHash = await readFile(
        path.join(repo, 'docs', 'BRIEF.sha256'),
        'utf8',
      );
      expect(briefHash).toContain('sha256:');

      // The second attempt carried the diagnosis guidance in its stage prompt.
      const specCalls = mockRunAgentLoop.mock.calls.map(([o]) => o).filter((o) => o.request.includes('spec-seed'));
      expect(specCalls).toHaveLength(2);
      expect(specCalls[0]!.stagePrompt).not.toContain('GUIDANCE-MARKER-XYZ');
      expect(specCalls[1]!.stagePrompt).toContain('GUIDANCE-MARKER-XYZ');

      // Cost accumulates across both attempts: 3 + 3 turns for spec-seed.
      const out = lines.join('\n');
      expect(out).toContain('Per-stage cost summary');
      expect(out).toMatch(/spec-seed\s+\S+\s+6\s+/);

      // No real schematic, so the pipeline still halts at that stage.
      expect(res.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('commitResumedStage commits an already-complete, managed-only dirty tree so a later rollback cannot wipe it', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      await execa('git', ['add', 'brief.md'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'brief'], { cwd: repo });

      // The three doc stages' artifacts already exist but are uncommitted
      // (managed paths) — the resume-after-hard-kill situation.
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'SPEC.md'), '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
      await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# s\n\n## Power\n\nLDO regulator.\n', 'utf8');
      await writeFile(
        path.join(docs, 'BOM.md'),
        '# b\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | RC0603FR-0710KL | bias |\n',
        'utf8',
      );

      mockRunAgentLoop.mockImplementation(async () => ok()); // schematic still halts

      const lines: string[] = [];
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      expect(lines.join('\n')).toContain('committed already-complete work');
      const { stdout } = await execa('git', ['log', '--oneline'], { cwd: repo });
      expect(stdout).toMatch(/resume — commit completed stage/);
    } finally {
      await cleanup();
    }
  });

  it('commitResumedStage refuses to commit when the dirty tree also holds a foreign (non-copperhead) change', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      await execa('git', ['add', 'brief.md'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'brief'], { cwd: repo });

      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'SPEC.md'), '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
      // A user's own uncommitted file, unrelated to copperhead's managed paths.
      await writeFile(path.join(repo, 'my-notes.txt'), 'do not touch\n', 'utf8');

      mockRunAgentLoop.mockImplementation(async () => ok());

      const lines: string[] = [];
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      const out = lines.join('\n');
      expect(out).toContain('leaving it uncommitted');
      const { stdout } = await execa('git', ['log', '--oneline'], { cwd: repo });
      expect(stdout).not.toMatch(/resume — commit completed stage/);
    } finally {
      await cleanup();
    }
  });

  it('writes BRIEF.sha256 when spec-seed is resumed', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      const briefPath = await seedRepo(repo);

      await execa('git', ['add', 'brief.md'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'brief'], { cwd: repo });

      // Stage 1 already complete.
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(
        path.join(docs, 'SPEC.md'),
        '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n',
        'utf8',
      );

      // Resume path should create BRIEF.sha256.
      mockRunAgentLoop.mockImplementation(async () => ok());

      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: () => {},
      });

      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['spec-seed']);

      const briefHash = await readFile(
        path.join(repo, 'docs', 'BRIEF.sha256'),
        'utf8',
      );

      const expectedHash = createHash('sha256')
        .update('# tiny\n')
        .digest('hex');
      expect(briefHash).toContain('brief: brief.md');
      expect(briefHash).toContain(`sha256: ${expectedHash}`);
    } finally {
      await cleanup();
    }
  });

  it('records external brief provenance without leaking an absolute path', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    let externalDir: string | undefined;
    try {
      externalDir = await mkdtemp(path.join(tmpdir(), 'brief-'));
      const externalBrief = path.join(externalDir, 'outside-brief.md');
      await writeFile(externalBrief, '# external\n', 'utf8');
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      mockRunAgentLoop.mockImplementation(async (opts) => {
        await writeStageDoc(opts.repoRoot, opts.request);
        return ok();
      });
      const res = await runCreate({
        repoRoot: repo,
        briefPath: externalBrief,
        model: 'gpt-5',
        log: () => {},
      });
      expect(res.completed).toContain('spec-seed');
      const briefHash = await readFile(
        path.join(repo, 'docs', 'BRIEF.sha256'),
        'utf8',
      );

      expect(briefHash).toContain('brief: external:outside-brief.md');
      expect(briefHash).not.toContain(externalBrief);
    } finally {
      if (externalDir) {
        await rm(externalDir, { recursive: true, force: true });
      }
      await cleanup();
    }
  });

  it('writes BRIEF.sha256 to the configured docs directory', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      const briefPath = await seedRepo(repo);

      // Use a non-default docs directory.
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'documentation' }, null, 2),
        'utf8',
      );

      await mkdir(path.join(repo, 'documentation'), { recursive: true });
      await writeFile(
        path.join(repo, 'documentation', 'SPEC.md'),
        '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n',
        'utf8',
      );

      mockRunAgentLoop.mockImplementation(async () => ok());

      await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: () => {},
      });

      const briefHash = await readFile(
        path.join(repo, 'documentation', 'BRIEF.sha256'),
        'utf8',
      );

      expect(briefHash).toContain('sha256:');
    } finally {
      await cleanup();
    }
  });

  it('writes BRIEF.sha256 to the configured docs directory during a fresh spec-seed run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      const briefPath = await seedRepo(repo);

      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'documentation' }, null, 2),
        'utf8',
      );

      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('spec-seed')) {
          await mkdir(path.join(repo, 'documentation'), { recursive: true });

          await writeFile(
            path.join(repo, 'documentation', 'SPEC.md'),
            '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n',
            'utf8',
          );
        }

        return ok();
      });

      await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: () => {},
      });

      const briefHash = await readFile(
        path.join(repo, 'documentation', 'BRIEF.sha256'),
        'utf8',
      );

      expect(briefHash).toContain('sha256:');
    } finally {
      await cleanup();
    }
  });
});

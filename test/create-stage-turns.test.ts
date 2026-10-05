import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { RunOptions } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';

const mockRunAgentLoop = vi.hoisted(() =>
  vi.fn(async (opts: RunOptions) => {
    // Simulate each doc stage meeting its completion contract; a run whose
    // stage contract stays unmet halts the pipeline (see runCreate).
    const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
    const { default: pathMod } = await import('node:path');
    const docs = pathMod.join(opts.repoRoot, 'docs');
    await mkdirFs(docs, { recursive: true });
    if (opts.request.includes('spec-seed'))
      await writeFileFs(
        pathMod.join(docs, 'SPEC.md'),
        '# spec\n\n## Budgets\n\n- sleep_current_uA: 25\n',
        'utf8',
      );
    if (opts.request.includes('architecture'))
      await writeFileFs(
        pathMod.join(docs, 'SUBSYSTEMS.md'),
        '# subsystems\n\n## Power\n\nLDO regulator 3.3 V, 300 mA.\n',
        'utf8',
      );
    if (opts.request.includes('part-selection'))
      await writeFileFs(
        pathMod.join(docs, 'BOM.md'),
        '# bom\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | bias resistor |\n',
        'utf8',
      );
    return {
      outcome: 'success' as const,
      exitPath: 'done' as const,
      summary: 'mocked',
      transcriptDir: '',
      filesTouched: [],
      commit: null,
      stats: {
        exitPath: 'done' as const,
        turnsUsed: 3,
        maxTurns: 40,
        repairCyclesUsed: 0,
        maxRepairCycles: 5,
        tokensIn: 1000,
        tokensOut: 200,
        perTurn: [],
        durationMs: 1234,
      },
      cacheHits: 1,
    };
  }),
);

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: async () => ({ ok: true, output: 'mocked' }),
}));
const mockRunCheck = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('../src/commands/check.js', () => ({
  runCheck: mockRunCheck,
}));

import { runCreate, STAGES } from '../src/commands/create.js';

describe('create pipeline per-stage turn budgets (AC-15.18, AC-15.19)', () => {
  it('runs the final fabrication check in strict mode', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const originalCompletionChecks = STAGES.map((stage) => stage.isComplete);
    try {
      for (const stage of STAGES) stage.isComplete = async () => true;
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A complete device\n', 'utf8');
      mockRunCheck.mockClear();

      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });

      expect(res.ok).toBe(true);
      expect(mockRunCheck).toHaveBeenCalledWith(repo, expect.any(Function), { fab: true, strict: true });
    } finally {
      STAGES.forEach((stage, index) => { stage.isComplete = originalCompletionChecks[index]!; });
      await cleanup();
    }
  });

  it('a stage with a stageMaxTurns entry gets that budget; others get the default', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ stageMaxTurns: { 'spec-seed': 60 } }),
        'utf8',
      );
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n', 'utf8');

      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      // The mocked agent never produces a schematic, so the pipeline halts at
      // the schematic stage (successful run, contract unmet) after the three
      // doc stages complete — enough to observe both turn-budget paths.
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['spec-seed', 'architecture', 'part-selection']);

      const calls = mockRunAgentLoop.mock.calls.map(([opts]) => opts);
      const specSeed = calls.find((o) => o.request.includes('spec-seed'));
      const architecture = calls.find((o) => o.request.includes('architecture'));
      expect(specSeed?.maxTurns).toBe(60);
      expect(architecture?.maxTurns).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('on a stop, prints the exact resume command, the stage, and a per-stage cost table (5.2, 5.3)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n', 'utf8');
      const lines: string[] = [];
      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: (s) => lines.push(s),
      });
      expect(res.ok).toBe(false);
      const out = lines.join('\n');

      // 5.3: the one command to resume, with the flags, and which stage it stops at.
      expect(out).toContain('stopped at stage 4/8 (schematic)');
      expect(out).toMatch(/copperhead .*create --brief ['"]?[^'"]*brief\.md['"]? --model gpt-5/);
      expect(out).toContain('resumes at schematic');

      // 5.2: a cost table with a row per stage that ran and a TOTAL.
      expect(out).toContain('Per-stage cost summary');
      expect(out).toMatch(/Stage\s+Wall\s+Turns\s+Out tok\s+Cache/);
      expect(out).toMatch(/spec-seed\s+\S+\s+3\s+/); // turns from the mock's stats
      expect(out).toContain('TOTAL');
    } finally {
      await cleanup();
    }
  });
});

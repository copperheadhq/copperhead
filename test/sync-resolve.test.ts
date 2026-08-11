import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { syncVerify, syncResolve } from '../src/commands/sync.js';
import { tempFixtureRepo } from './helpers.js';
import { runInit } from '../src/memory/scaffold.js';
import { saveConstraint } from '../src/memory/constraints.js';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));

describe('copperhead sync resolve phase (AC-7.1 / AC-7.5)', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
  });

  it('syncResolve calls runAgentLoop with correct stage prompt and resolves inconsistencies', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      
      // Induce some drift
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      const bom = await readFile(bomPath, 'utf8');
      await writeFile(bomPath, bom.replace('| R1 | 10k |', '| R1 | 47k |'), 'utf8');

      // Verify first
      const report = await syncVerify(repo);
      expect(report.resolvable).toHaveLength(1);

      // Mock loop outcome
      mockRunAgentLoop.mockResolvedValueOnce({
        outcome: 'success',
        exitPath: 'done',
        summary: 'resolved',
        transcriptDir: '',
        filesTouched: [],
        commit: null,
        stats: {
          exitPath: 'done',
          turnsUsed: 1,
          tokensIn: 100,
          tokensOut: 50,
          cacheHits: 0,
        },
      });

      // Run resolve phase
      const res = await syncResolve(repo, report, 'gpt-5', () => {});
      expect(res.ok).toBe(true);

      // Assert runAgentLoop was called with expected stage prompt containing drift info
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
      const calledOpts = mockRunAgentLoop.mock.calls[0]?.[0];
      expect(calledOpts?.model).toBe('gpt-5');
      expect(calledOpts?.request).toContain('resolve design-state inconsistencies');
      expect(calledOpts?.stagePrompt).toContain('update BOM.md to match the as-built');
    } finally {
      await cleanup();
    }
  });

  it('syncResolve handles dual-write gaps correctly', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });

      // Induce dual-write gap: constraint exists in registry but no doc mentions it
      await saveConstraint(repo, 'rf.antenna_keepout_mm', {
        min: 5,
        source: 'docs/LAYOUT.md',
        affects: ['zone:top'],
      });

      // Verify
      const report = await syncVerify(repo);
      expect(report.resolvable.some((i) => i.kind === 'dual-write')).toBe(true);

      // Mock loop outcome
      mockRunAgentLoop.mockResolvedValueOnce({
        outcome: 'success',
        exitPath: 'done',
        summary: 'resolved-dual-write',
        transcriptDir: '',
        filesTouched: [],
        commit: null,
        stats: { exitPath: 'done', turnsUsed: 1, tokensIn: 50, tokensOut: 20, cacheHits: 0 },
      });

      // Resolve
      const res = await syncResolve(repo, report, 'gpt-5', () => {});
      expect(res.ok).toBe(true);
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
      const calledOpts = mockRunAgentLoop.mock.calls[0]?.[0];
      expect(calledOpts?.stagePrompt).toContain('constraints.json');
      expect(calledOpts?.stagePrompt).toContain('add the constraint to the doc named by its source');
    } finally {
      await cleanup();
    }
  });

  it('syncResolve passes requirement violations in prompt and instructs agent to ignore them', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });

      // Induce violation: forbidden pin GPIO14
      await saveConstraint(repo, 'pins.forbidden_gpio14', {
        forbidden: ['GPIO14'],
        source: 'esp32-s3 datasheet',
        affects: ['U1'],
      });

      // Verify
      const report = await syncVerify(repo);
      expect(report.violations).toHaveLength(1);

      // Mock loop outcome
      mockRunAgentLoop.mockResolvedValueOnce({
        outcome: 'success',
        exitPath: 'done',
        summary: 'done-ignoring-violations',
        transcriptDir: '',
        filesTouched: [],
        commit: null,
        stats: { exitPath: 'done', turnsUsed: 1, tokensIn: 50, tokensOut: 20, cacheHits: 0 },
      });

      // Resolve
      const res = await syncResolve(repo, report, 'gpt-5', () => {});
      expect(res.ok).toBe(true);
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
      const calledOpts = mockRunAgentLoop.mock.calls[0]?.[0];
      expect(calledOpts?.stagePrompt).toContain('Do NOT touch anything listed as a requirement violation');
      expect(calledOpts?.stagePrompt).toContain('GPIO14');
    } finally {
      await cleanup();
    }
  });
});

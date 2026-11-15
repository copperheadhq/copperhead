import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { runInit } from '../src/memory/scaffold.js';
import { ExternalChangeError } from '../src/util/worktree-ownership.js';
const fault = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock('../src/util/git.js', async (original) => {
  const actual = await original<typeof import('../src/util/git.js')>();
  return { ...actual, restore: (...args: Parameters<typeof actual.restore>) => {
    const error = fault.restore();
    if (error) return Promise.reject(error);
    return actual.restore(...args);
  } };
});
afterEach(() => fault.restore.mockReset());

describe('refusal and dry-run rollback errors', () => {
  for (const exit of ['refuse', 'dry-run'] as const) {
    for (const external of [false, true]) {
      it(`${exit} ${external ? 'classifies external changes' : 'propagates unrelated I/O errors'}`, async () => {
        const f = await tempFixtureRepo();
        try {
          await runInit({ repoRoot: f.repo, installHooks: false });
          await execa('git', ['add', '-A'], { cwd: f.repo });
          await execa('git', ['commit', '-qm', 'docs'], { cwd: f.repo });
          const error = external ? new ExternalChangeError('scripted conflict') : new Error('scripted I/O failure');
          fault.restore.mockReturnValueOnce(error);
          const run = runAgentLoop({
            repoRoot: f.repo, request: 'offline rollback classification', model: 'gpt-5', maxTurns: 1,
            dryRun: exit === 'dry-run', log: () => {},
            provider: { name: 'scripted', async chat() {
              return { text: null, toolCalls: [{ id: 'finish', name: 'finish', args: { outcome: exit === 'refuse' ? 'refuse' : 'done', summary: 'stop' } }], usage: { inputTokens: 1, outputTokens: 1 } };
            } },
          });
          if (external) expect((await run).exitPath).toBe('external-change');
          else await expect(run).rejects.toBe(error);
          expect(fault.restore).toHaveBeenCalled();
        } finally { await f.cleanup(); }
      });
    }
  }
});

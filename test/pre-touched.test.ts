import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { loadConfig } from '../src/config.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * `preTouched` (AC-15.43): a file the caller changed before the run (the
 * create pipeline's populated board) counts as the run's own edit, so the run
 * cannot finish until its verification passes, even if the agent never
 * touches it.
 */

/** Plays each turn in order, repeating the last one; keeps every prompt it saw. */
function scriptedProvider(turns: Partial<Turn>[]): Provider & { seen: Msg[][] } {
  let i = 0;
  const seen: Msg[][] = [];
  return {
    name: 'scripted',
    seen,
    async chat(messages: Msg[]): Promise<Turn> {
      seen.push([...messages]);
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return {
        text: t.text ?? null,
        toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })),
        usage: t.usage ?? { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
}

const finishNow = { toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'placed' } }] };

async function initializedRepo(): Promise<{ repo: string; board: string; cleanup: () => Promise<void> }> {
  const { repo, cleanup } = await tempFixtureRepo();
  await runInit({ repoRoot: repo, installHooks: false });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'docs'], { cwd: repo });
  const board = (await loadConfig(repo)).board;
  if (!board) throw new Error('fixture has no board');
  return { repo, board, cleanup };
}

describe('preTouched files carry the run’s verification (AC-15.43)', () => {
  it('finish refuses until DRC passes on a pre-touched board the agent never edited', async () => {
    const { repo, board, cleanup } = await initializedRepo();
    try {
      const provider = scriptedProvider([finishNow]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'layout',
        model: 'gpt-5',
        provider,
        maxTurns: 2,
        preTouched: [board],
        log: () => {},
      });
      expect(res.outcome).not.toBe('success');
      const toolResults = provider.seen.flat().map((m) => JSON.stringify(m)).join('\n');
      expect(toolResults).toContain('cannot finish yet');
      expect(toolResults).toContain('DRC has not passed since the last board edit');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('without preTouched the same run finishes: nothing it touched needs verifying', async () => {
    const { repo, cleanup } = await initializedRepo();
    try {
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'layout',
        model: 'gpt-5',
        provider: scriptedProvider([finishNow]),
        maxTurns: 2,
        log: () => {},
      });
      expect(res.outcome).toBe('success');
    } finally {
      await cleanup();
    }
  }, 60_000);
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { execa } from 'execa';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { loadConfig } from '../src/config.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * The repair budget is checked once per turn, after every tool call of the
 * turn ran. A batched turn that spends the last cycle, then fixes the board,
 * passes its checks and calls `finish` has no violation left to roll back
 * for: `finish` is approved only after ERC/DRC passed, so the run finishes
 * (SPEC §4 step 5; the loop reads `ctx.finishRequest` before the budget).
 */

/** Plays each turn in order, repeating the last one. */
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

const OUTLINE = '(gr_rect (start 100 100) (end 140 130)';
// a copper track across the board edge: a copper_edge_clearance error
const BAD_TRACK = (width: number): string => `(segment (start 110 115) (end 90 115) (width ${width}) (layer "F.Cu") (net 0))\n  `;
const edit = (board: string, old_string: string, new_string: string) => ({ name: 'edit_file', args: { path: board, old_string, new_string } });

describe('repair budget and a turn that finishes verified', () => {
  // Hermetic like CI: with no global sym-lib-table KiCad checks the sheet's own
  // embedded symbols, so a machine whose Device library differs from the
  // fixture's copies does not fail ERC with lib_symbol_mismatch warnings.
  let emptyConfig = '';
  beforeEach(async () => {
    emptyConfig = await mkdtemp(path.join(tmpdir(), 'kicadcfg-finish-guard-'));
    vi.stubEnv('KICAD_CONFIG_HOME', emptyConfig);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(emptyConfig, { recursive: true, force: true });
  });

  it('a batched turn that spends the last repair cycle, fixes the board, passes DRC and finishes is not rolled back', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const configPath = path.join(repo, '.copperhead', 'config.json');
      await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, 'utf8')), maxRepairCycles: 1 }, null, 2), 'utf8');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'docs'], { cwd: repo });
      const board = (await loadConfig(repo)).board!;
      const before = await readFile(path.join(repo, board), 'utf8');
      const provider = scriptedProvider([
        // turn 1: unlock the edit tools
        {
          toolCalls: [
            { name: 'propose_change', args: { id: 'finish-guard', why: 'testing', what_changes: '- a track', tasks: '- [ ] test' } },
            { name: 'validate_change', args: {} },
          ],
        },
        // turn 2: break the board (the first failure after a clean state is free)
        { toolCalls: [edit(board, OUTLINE, BAD_TRACK(0.25) + OUTLINE), { name: 'run_drc', args: {} }] },
        // turn 3: a repair that does not help (the one cycle: budget exhausted), then the real fix,
        // the checks and finish, all in one reply
        {
          toolCalls: [
            edit(board, BAD_TRACK(0.25), BAD_TRACK(0.3)),
            { name: 'run_drc', args: {} },
            edit(board, BAD_TRACK(0.3), ''),
            { name: 'run_drc', args: {} },
            { name: 'run_erc', args: {} },
            { name: 'check_drift', args: {} },
            { name: 'finish', args: { outcome: 'done', summary: 'track removed' } },
          ],
        },
      ]);
      const res = await runAgentLoop({ repoRoot: repo, request: 'layout', model: 'gpt-5', provider, maxTurns: 4, log: () => {} });
      const seen = provider.seen.flat().map((m) => JSON.stringify(m)).join('\n');
      expect(seen).toContain('copper_edge_clearance');
      // the last turn's results never reach the provider: on a failure, show them from the transcript
      const jsonl = (await readdir(res.transcriptDir)).find((f) => f.endsWith('.jsonl'))!;
      const events = (await readFile(path.join(res.transcriptDir, jsonl), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; data?: { name?: string; result?: string } });
      const finishReply = events.filter((e) => e.type === 'tool').map((e) => `${e.data?.name}: ${String(e.data?.result).split('\n')[0]}`).join('\n');
      expect(res.exitPath, `${res.summary}\n${finishReply}`).not.toBe('repair-cycles-exhausted');
      expect(res.outcome, res.summary).toBe('success');
      expect(res.stats.repairCycles ?? 1).toBe(1);
      // the board is the fixed one, byte-identical to the pre-run board
      expect(await readFile(path.join(repo, board), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

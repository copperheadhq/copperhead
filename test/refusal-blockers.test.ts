import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { saveConstraint } from '../src/memory/constraints.js';
import { tempFixtureRepo } from './helpers.js';

/** Scripted provider: plays each turn in order, repeats the last one. */
function scriptedProvider(turns: Partial<Turn>[]): Provider {
  let i = 0;
  return {
    name: 'scripted',
    async chat(_messages: Msg[]): Promise<Turn> {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return {
        text: t.text ?? null,
        toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })),
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
}

const blocker = {
  kind: 'constraint-conflict',
  constraint: 'protection.precharge_bypass',
  required: '≥ 16 A',
  found: 'G5Q-1A4 relay, 6 A',
};

async function events(transcriptDir: string, type: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(transcriptDir, 'transcript.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === type)
    .map((e) => e.data);
}

describe('structured refusal blockers (AC-18.1, AC-18.2)', () => {
  it('a blocker on a registered key is verified and carried to the result, the event and the summary', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await saveConstraint(repo, 'protection.precharge_bypass', { min: 16, source: 'docs/SPEC.md', affects: [] });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-qm', 'register the bypass constraint'], { cwd: repo });
      const provider = scriptedProvider([
        { toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'no relay meets the bypass current', blockers: [blocker] } }] },
      ]);
      const res = await runAgentLoop({ repoRoot: repo, request: 'pick the relay', model: 'gpt-5', provider, maxTurns: 3, log: () => {} });
      expect(res.outcome).toBe('refused');
      expect(res.blockers).toEqual([blocker]);

      const summary = await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8');
      expect(summary).toContain('REFUSED: no relay meets the bypass current');
      expect(summary).toContain('[verified] constraint-conflict `protection.precharge_bypass`: required ≥ 16 A; found G5Q-1A4 relay, 6 A');

      const [refused] = await events(res.transcriptDir, 'run-refused');
      expect(refused?.blockers).toEqual([{ ...blocker, verified: true }]);
    } finally {
      await cleanup();
    }
  });

  it('an unregistered key yields no verified blocker and is kept as an unverified claim', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([
        { toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'relay too small', blockers: [blocker] } }] },
      ]);
      const res = await runAgentLoop({ repoRoot: repo, request: 'pick the relay', model: 'gpt-5', provider, maxTurns: 3, log: () => {} });
      expect(res.outcome).toBe('refused');
      expect(res.blockers).toEqual([]);
      expect(res.summary).toContain('(unverified claim) constraint "protection.precharge_bypass" is not in the registry');

      const summary = await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8');
      expect(summary).toContain('[unverified claim] constraint-conflict `protection.precharge_bypass`');
      const [refused] = await events(res.transcriptDir, 'run-refused');
      expect(refused?.blockers).toEqual([{ ...blocker, verified: false }]);
    } finally {
      await cleanup();
    }
  });

  it('blockers with outcome done are rejected with a clear message, and the run goes on', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([
        { toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'all good', blockers: [blocker] } }] },
        { toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'cannot satisfy it after all' } }] },
      ]);
      const res = await runAgentLoop({ repoRoot: repo, request: 'pick the relay', model: 'gpt-5', provider, maxTurns: 3, log: () => {} });
      expect(res.outcome).toBe('refused');
      const tools = await events(res.transcriptDir, 'tool');
      const first = tools.find((t) => t.name === 'finish');
      expect(String(first?.result)).toContain('blockers accompany outcome "refuse" only');
    } finally {
      await cleanup();
    }
  });

  it('a malformed blocker is rejected by field', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([
        { toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'x', blockers: [{ kind: 'constraint-conflict', constraint: 'a' }] } }] },
        { toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'plain refusal' } }] },
      ]);
      const res = await runAgentLoop({ repoRoot: repo, request: 'pick the relay', model: 'gpt-5', provider, maxTurns: 3, log: () => {} });
      const tools = await events(res.transcriptDir, 'tool');
      expect(String(tools.find((t) => t.name === 'finish')?.result)).toContain('blockers[0].required must be a non-empty string');
      expect(res.outcome).toBe('refused');
      expect(res.summary).toBe('plain refusal');
    } finally {
      await cleanup();
    }
  });
});

describe('a refusal preserves touched work (AC-18.3, AC-15.17)', () => {
  it('touched files are stashed under the run id, the tree is restored, and the stash ref is printed', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { stdout: statusBefore } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      const provider = scriptedProvider([
        {
          toolCalls: [
            { name: 'propose_change', args: { id: 'refuse-after-draft', why: 'test', what_changes: '- test', tasks: '- [ ] test' } },
            { name: 'validate_change', args: {} },
          ],
        },
        { toolCalls: [{ name: 'write_file', args: { path: 'docs/BOM.md', content: '| Refdes | Value |\n|---|---|\n| K1 | G5Q-1A4 |\n' } }] },
        { toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'relay fails the bypass current' } }] },
      ]);
      const lines: string[] = [];
      const res = await runAgentLoop({ repoRoot: repo, request: 'pick the relay', model: 'gpt-5', provider, maxTurns: 5, log: (l) => lines.push(l) });
      expect(res.outcome).toBe('refused');

      const runId = path.basename(res.transcriptDir);
      const { stdout: stashes } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stashes).toContain(`copperhead failed run ${runId}`);
      const { stdout: statusAfter } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(statusAfter).toBe(statusBefore);
      expect(existsSync(path.join(repo, 'openspec', 'changes', 'refuse-after-draft'))).toBe(false);

      // The draft is in the stash, byte for byte.
      const entry = /^(stash@\{\d+\}):.*copperhead failed run /m.exec(stashes)![1]!;
      const { stdout: bom } = await execa('git', ['show', `${entry}:docs/BOM.md`], { cwd: repo });
      expect(bom).toContain('| K1 | G5Q-1A4 |');

      const preservedLine = lines.find((l) => l.startsWith('refused work preserved:'));
      expect(preservedLine).toContain(`copperhead failed run ${runId}`);
      expect(lines.some((l) => l.startsWith('transcript: '))).toBe(true);
      const [preserved] = await events(res.transcriptDir, 'work-preserved');
      expect(typeof preserved?.stash).toBe('string');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('a clean refusal leaves no stash entry', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([
        { toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'nothing to do' } }] },
      ]);
      const lines: string[] = [];
      const res = await runAgentLoop({ repoRoot: repo, request: 'pick the relay', model: 'gpt-5', provider, maxTurns: 3, log: (l) => lines.push(l) });
      expect(res.outcome).toBe('refused');
      const { stdout: stashes } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stashes).toBe('');
      expect(lines.some((l) => l.includes('preserved'))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import { availableTools, dispatchToolResult, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import type { Provider, Turn } from '../src/agent/types.js';
import { loadConfig } from '../src/config.js';
import { tempFixtureRepo } from './helpers.js';

const proposal = (id = 'test-change') => ({ id, why: 'Test the gate', what_changes: '- Update notes', tasks: '- [ ] Update' });
const call = (name: string, args: Record<string, unknown>) => ({ id: name, name, args });
const done = () => call('finish', { outcome: 'done', summary: 'Completed' });

function scripted(turns: Turn['toolCalls'][]): Provider {
  let next = 0;
  return {
    name: 'scripted',
    async chat() {
      return { text: null, toolCalls: turns[next++] ?? [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

async function context(repoRoot: string): Promise<RunContext> {
  const transcript = new Transcript(repoRoot);
  await transcript.init();
  return {
    repoRoot, config: await loadConfig(repoRoot), transcript, ledger: new ObligationsLedger(),
    runId: 'gate-test', interactive: false, confirm: async () => true,
    editsUnlocked: false, changeId: null, proposalValidated: false,
    filesTouched: new Set(), decisions: [], lastErc: null, lastDrc: null,
    lastLegibility: null, lastScore: null, repairCycles: 0, finishRequest: null,
  };
}

describe('terminal verification and proposal gates', () => {
  it('does not execute unverified writes after an accepted finish in the same reply', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scripted([
        [call('propose_change', proposal()), call('validate_change', {})],
        [done(), call('write_file', { path: 'hardware/unverified.kicad_pcb', content: '(kicad_pcb)' })],
      ]);
      const result = await runAgentLoop({ repoRoot: repo, request: 'noop', model: 'test', provider, maxTurns: 2, log: () => {} });
      expect(result.outcome).toBe('success');
      await expect(readFile(path.join(repo, 'hardware/unverified.kicad_pcb'))).rejects.toMatchObject({ code: 'ENOENT' });
      const events = (await readFile(path.join(result.transcriptDir, 'transcript.jsonl'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line));
      expect(events.filter((event) => event.type === 'tool').map((event) => event.data.name))
        .toEqual(['propose_change', 'validate_change', 'finish']);
    } finally { await cleanup(); }
  });

  it('cannot override a refusal with a later finish in the same reply', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scripted([[call('finish', { outcome: 'refuse', summary: 'Budget violation' }), done()]]);
      const result = await runAgentLoop({ repoRoot: repo, request: 'noop', model: 'test', provider, maxTurns: 1, log: () => {} });
      expect(result.outcome).toBe('refused');
      expect(result.commit).toBeNull();
    } finally { await cleanup(); }
  });

  it('rolls back and preserves work when the required changelog cannot be written', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs/.keep'), 'original');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-qm', 'blocked changelog'], { cwd: repo });
      const { stdout: before } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const script = scripted([
        [call('propose_change', proposal()), call('validate_change', {})],
        [call('write_file', { path: 'NOTES.txt', content: 'recoverable work' }), done()],
      ]);
      const provider: Provider = {
        name: 'scripted',
        async chat(...args) {
          // Simulate a concurrent filesystem failure after prompt loading,
          // so the test exercises the commit gate rather than startup reads.
          await mkdir(path.join(repo, 'docs/CHANGELOG.md'), { recursive: true });
          await writeFile(path.join(repo, 'docs/CHANGELOG.md/keep'), 'blocked');
          return script.chat(...args);
        },
      };
      const result = await runAgentLoop({ repoRoot: repo, request: 'notes', model: 'test', provider, maxTurns: 2, log: () => {} });
      expect(result.outcome).toBe('failure');
      expect(result.exitPath).toBe('commit-failed');
      expect(result.summary).toContain('changelog append failed');
      expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout).toBe(before);
      expect((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout).toBe('');
      expect((await execa('git', ['stash', 'show', '--include-untracked', '--name-only', 'stash@{0}'], { cwd: repo })).stdout)
        .toContain('NOTES.txt');
    } finally { await cleanup(); }
  });

  it('relocks tools when the validated proposal is replaced', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ctx = await context(repo);
      await dispatchToolResult(ctx, 'propose_change', proposal());
      await dispatchToolResult(ctx, 'validate_change', {});
      expect(ctx.editsUnlocked).toBe(true);
      await dispatchToolResult(ctx, 'propose_change', proposal('replacement'));
      expect(ctx.proposalValidated).toBe(false);
      expect(availableTools(ctx).map((entry) => entry.name)).not.toContain('write_file');
      expect((await dispatchToolResult(ctx, 'write_file', { path: 'NOTES.txt', content: 'no' })).ok).toBe(false);
      expect((await dispatchToolResult(ctx, 'finish', { outcome: 'done', summary: 'premature' })).ok).toBe(false);
      expect(ctx.finishRequest).toBeNull();
      await dispatchToolResult(ctx, 'validate_change', {});
      expect(ctx.editsUnlocked).toBe(true);
    } finally { await cleanup(); }
  });

  it('relocks on failed revalidation and on declined interactive reapproval', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ctx = await context(repo);
      await dispatchToolResult(ctx, 'propose_change', proposal());
      await dispatchToolResult(ctx, 'validate_change', {});
      await rm(path.join(repo, 'openspec/changes/test-change/tasks.md'));
      expect((await dispatchToolResult(ctx, 'validate_change', {})).ok).toBe(false);
      expect(ctx.editsUnlocked).toBe(false);
      expect(ctx.proposalValidated).toBe(false);
      expect((await dispatchToolResult(ctx, 'finish', { outcome: 'done', summary: 'premature' })).ok).toBe(false);
      await dispatchToolResult(ctx, 'propose_change', proposal());
      await dispatchToolResult(ctx, 'validate_change', {});
      ctx.interactive = true;
      ctx.confirm = async () => false;
      expect((await dispatchToolResult(ctx, 'validate_change', {})).ok).toBe(false);
      expect(ctx.editsUnlocked).toBe(false);
      expect((await dispatchToolResult(ctx, 'finish', { outcome: 'done', summary: 'declined' })).ok).toBe(false);
      expect(ctx.finishRequest).toBeNull();
    } finally { await cleanup(); }
  });

  it('rejects proposal path traversal and invalid finish outcomes', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ctx = await context(repo);
      expect((await dispatchToolResult(ctx, 'propose_change', proposal('../../docs'))).ok).toBe(false);
      expect(ctx.changeId).toBeNull();
      await expect(readFile(path.join(repo, 'docs/proposal.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await dispatchToolResult(ctx, 'finish', { outcome: 'typo', summary: 'no' })).ok).toBe(false);
      expect(ctx.finishRequest).toBeNull();
    } finally { await cleanup(); }
  });
});

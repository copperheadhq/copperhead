import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { runAgentLoop, type BudgetExhaustedStats } from '../src/agent/loop.js';
import type { Msg, Provider, ToolSchema, Turn } from '../src/agent/types.js';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { buildSystemPrompt } from '../src/agent/prompts.js';
import { preserveFailedRun, snapshot, restore, isDirty } from '../src/util/git.js';
import { loadConfig } from '../src/config.js';
import { loadConstraints } from '../src/memory/constraints.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * Offline tests for issue #15: continue-on-exhaustion, failed-work
 * preservation, obligation deferral, batch resolution, prompt guidance,
 * Anthropic prompt caching, per-stage budgets.
 */

/** Scripted provider: plays each turn in order, repeats the last one. */
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

const readCall = { name: 'read_file', args: { path: 'hardware/open-key.kicad_sch', start_line: 1, end_line: 2 } };

async function makeCtx(repo: string): Promise<RunContext> {
  const transcript = new Transcript(repo);
  await transcript.init();
  return {
    repoRoot: repo,
    config: await loadConfig(repo),
    transcript,
    ledger: new ObligationsLedger(),
    runId: 'test-run',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: true,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    repairCycles: 0,
    finishRequest: null,
  };
}

describe('turn-budget exhaustion (AC-15.1..15.4)', () => {
  it('granting extra turns continues the run to success, with a budget-extended event', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'docs'], { cwd: repo });
      const provider = scriptedProvider([
        { toolCalls: [readCall] },
        { toolCalls: [readCall] },
        { toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'nothing to do' } }] },
      ]);
      const calls: BudgetExhaustedStats[] = [];
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider,
        maxTurns: 2,
        onBudgetExhausted: async (stats) => {
          calls.push(stats);
          return 3;
        },
        log: () => {},
      });
      expect(res.outcome).toBe('success');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.turnsUsed).toBe(2);
      // the ORIGINAL budget, so the CLI can offer a constant increment
      expect(calls[0]!.maxTurns).toBe(2);
      // AC-15.4: token usage visible at the decision point (2 turns x 100/10)
      expect(calls[0]!.tokensIn).toBe(200);
      expect(calls[0]!.tokensOut).toBe(20);
      const jsonl = await readFile(path.join(res.transcriptDir, 'transcript.jsonl'), 'utf8');
      expect(jsonl).toContain('"budget-extended"');
      expect(jsonl).toContain('"extraTurns":3');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('declining keeps fail-and-restore, but preserves the touched work in a stash (AC-15.16)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([
        {
          toolCalls: [
            { name: 'propose_change', args: { id: 'c1', why: 'w', what_changes: '- x', tasks: '- [ ] t' } },
            { name: 'validate_change', args: {} },
          ],
        },
        { toolCalls: [{ name: 'write_file', args: { path: 'NOTES.md', content: 'important work\n' } }] },
        { toolCalls: [readCall] },
      ]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider,
        maxTurns: 3,
        onBudgetExhausted: async () => 0,
        log: () => {},
      });
      expect(res.outcome).toBe('failure');
      expect(res.summary).toContain('turn budget exhausted');
      // tree restored byte-identical...
      const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(status).toBe('');
      // ...but the work survives in a named stash entry
      const { stdout: stashes } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stashes).toContain('copperhead failed run');
      const { stdout: stashFiles } = await execa('git', ['stash', 'show', '--include-untracked', '--name-only', 'stash@{0}'], {
        cwd: repo,
      });
      expect(stashFiles).toContain('NOTES.md');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('no callback (non-interactive) fails exactly as before, no stash for an untouched tree (AC-15.3, AC-15.17)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([{ toolCalls: [readCall] }]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider,
        maxTurns: 2,
        log: () => {},
      });
      expect(res.outcome).toBe('failure');
      const { stdout: stashes } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stashes).toBe('');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('a throwing callback reads as declined: the run still restores instead of crashing past rollback', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([
        {
          toolCalls: [
            { name: 'propose_change', args: { id: 'c1', why: 'w', what_changes: '- x', tasks: '- [ ] t' } },
            { name: 'validate_change', args: {} },
          ],
        },
        { toolCalls: [{ name: 'write_file', args: { path: 'NOTES.md', content: 'work\n' } }] },
      ]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider,
        maxTurns: 2,
        onBudgetExhausted: async () => {
          throw new Error('stdin closed');
        },
        log: () => {},
      });
      expect(res.outcome).toBe('failure');
      expect(res.summary).toContain('turn budget exhausted');
      const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(status).toBe('');
      const { stdout: stashes } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stashes).toContain('copperhead failed run');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('the 5-turns-remaining nudge tells the model to batch tool calls (AC-15.6)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([
        { toolCalls: [readCall] },
        { toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'stop here' } }] },
      ]);
      await runAgentLoop({ repoRoot: repo, request: 'noop', model: 'gpt-5', provider, maxTurns: 6, log: () => {} });
      const secondTurnMessages = provider.seen[1]!;
      const nudge = secondTurnMessages.filter((m) => m.role === 'user').map((m) => (m as { content: string }).content);
      expect(nudge.some((c) => c.includes('Only 5 turns remain') && c.includes('Batch independent tool calls'))).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('stops dispatching calls queued after finish in the same batch', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([
        {
          toolCalls: [
            { name: 'propose_change', args: { id: 'batch-finish-guard', why: 'test', what_changes: '- test', tasks: '- [ ] test' } },
            { name: 'validate_change', args: {} },
          ],
        },
        {
          toolCalls: [
            { name: 'finish', args: { outcome: 'done', summary: 'all gates are clear' } },
            { name: 'write_file', args: { path: 'NOTES.md', content: 'must not be written\n' } },
          ],
        },
      ]);
      const lines: string[] = [];
      const res = await runAgentLoop({ repoRoot: repo, request: 'guard finish batching', model: 'gpt-5', provider, maxTurns: 3, log: (l) => lines.push(l) });

      expect(res.outcome).toBe('success');
      await expect(readFile(path.join(repo, 'NOTES.md'), 'utf8')).rejects.toThrow();
      expect(lines).toContain('skipped 1 tool call(s) queued after finish');

      const transcript = await readFile(path.join(res.transcriptDir, 'transcript.jsonl'), 'utf8');
      expect(transcript).toContain('tool-calls-skipped-after-finish');
      expect(transcript).toContain('NOTES.md');
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe('preserveFailedRun (safety-rails)', () => {
  it('stashes tracked and untracked changes under the run id; work is recoverable after restore', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const snap = await snapshot(repo);
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const before = await readFile(sch, 'utf8');
      await writeFile(sch, before.replace('KEY_DAH', 'KEY_EDITED'), 'utf8');
      await writeFile(path.join(repo, 'new-doc.md'), 'untracked work\n', 'utf8');

      const sha = await preserveFailedRun(repo, 'run-42');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const { stdout: stashes } = await execa('git', ['stash', 'list'], { cwd: repo });
      expect(stashes).toContain('copperhead failed run run-42');

      await restore(repo, snap);
      expect(await isDirty(repo)).toBe(false);
      await execa('git', ['stash', 'apply'], { cwd: repo });
      expect(await readFile(sch, 'utf8')).toContain('KEY_EDITED');
      expect((await readFile(path.join(repo, 'new-doc.md'), 'utf8')).replace(/\r\n/g, '\n')).toBe('untracked work\n');
    } finally {
      await cleanup();
    }
  });

  it('returns null on a clean tree', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await preserveFailedRun(repo, 'run-43')).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

// Obligation deferral for not-yet-built artifacts is provided by the persisted
// constraint-registry mechanism on main (classifyAffectsTarget +
// reopenDeferredAffects); this PR keeps the resolve_affected batch form and the
// budget/continue machinery on top of it. These two tests pin the reconciled
// contract: a not-yet-built artifact defers (persisted, no in-run obligation),
// an existing artifact and a bare refdes open obligations now.
describe('deferred revisit obligations (reconciled with main)', () => {
  it('does not open an obligation for an artifact that does not exist yet; persists it as deferred', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ctx = await makeCtx(repo);
      expect(ctx.config.schematic).toBeNull();
      const res = await dispatchTool(ctx, 'record_constraint', {
        key: 'power.sleep_current_uA',
        max: 25,
        source: 'brief',
        affects: ['schematic', 'layout'],
      });
      expect(ctx.ledger.openOfKind('affects-revisit')).toHaveLength(0);
      expect(res).toContain('deferred until the target artifact exists');
      const registry = await loadConstraints(repo);
      expect(registry['power.sleep_current_uA']!.deferred).toEqual(['schematic', 'layout']);
      // deferral never blocks finish
      const done = await dispatchTool(ctx, 'finish', { outcome: 'done', summary: 'seeded' });
      expect(done).toContain('all gates satisfied');
    } finally {
      await cleanup();
    }
  });

  it('opens obligations for an existing artifact and for a bare refdes', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo);
      expect(ctx.config.schematic).toBeTruthy();
      await dispatchTool(ctx, 'record_constraint', {
        key: 'power.sleep_current_uA',
        max: 25,
        source: 'docs/SPEC.md',
        affects: ['schematic', 'R1'],
      });
      expect(ctx.ledger.openOfKind('affects-revisit')).toHaveLength(2);
      const registry = await loadConstraints(repo);
      expect(registry['power.sleep_current_uA']!.deferred).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('resolve_affected batch form (AC-15.9, AC-15.10)', () => {
  it('one call clears several obligations', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo);
      await dispatchTool(ctx, 'record_constraint', {
        key: 'power.sleep_current_uA',
        max: 25,
        source: 'docs/SPEC.md',
        affects: ['R1', 'R2', 'U1'],
      });
      expect(ctx.ledger.openOfKind('affects-revisit')).toHaveLength(3);
      const res = await dispatchTool(ctx, 'resolve_affected', {
        resolutions: [
          { constraint_key: 'power.sleep_current_uA', item: 'R1', resolution: 'no change needed: EN pullup' },
          { constraint_key: 'power.sleep_current_uA', item: 'R2', resolution: 'no change needed: not in sleep path' },
          { constraint_key: 'power.sleep_current_uA', item: 'U1', resolution: 'changed: picked low-Iq LDO' },
        ],
      });
      expect(ctx.ledger.openOfKind('affects-revisit')).toHaveLength(0);
      expect(res.split('\n').filter((l) => l.startsWith('resolved:'))).toHaveLength(3);
      expect(ctx.decisions).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });

  it('a bad entry does not waste the call: per-entry results', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo);
      await dispatchTool(ctx, 'record_constraint', {
        key: 'power.cc_rd_ohms',
        max: 5100,
        source: 'docs/SPEC.md',
        affects: ['CC1', 'CC2'],
      });
      const res = await dispatchTool(ctx, 'resolve_affected', {
        resolutions: [
          { constraint_key: 'power.cc_rd_ohms', item: 'CC1', resolution: 'changed: 5.1k' },
          { constraint_key: 'power.cc_rd_ohms', item: 'CC-nope', resolution: 'changed: 5.1k' },
        ],
      });
      expect(res).toContain('resolved: power.cc_rd_ohms affects CC1');
      expect(res).toContain('error: no open affects-revisit obligation matches "power.cc_rd_ohms affects CC-nope"');
      expect(ctx.ledger.openOfKind('affects-revisit')).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('neither form given is a corrective error', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ctx = await makeCtx(repo);
      const res = await dispatchTool(ctx, 'resolve_affected', {});
      expect(res).toContain('error:');
      expect(res).toContain('resolutions');
    } finally {
      await cleanup();
    }
  });
});

describe('convergence feedback (AC-15.12, AC-15.13)', () => {
  it('run_erc / run_drc without artifacts read as not-applicable, not retryable', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ctx = await makeCtx(repo);
      expect(await dispatchTool(ctx, 'run_erc', {})).toContain('does not apply yet');
      expect(await dispatchTool(ctx, 'run_drc', {})).toContain('does not apply yet');
    } finally {
      await cleanup();
    }
  });

  it('empty search pattern gets a corrective hint', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ctx = await makeCtx(repo);
      const res = await dispatchTool(ctx, 'search', { pattern: '' });
      expect(res).toContain('non-empty regex');
      expect(res).toContain('e.g.');
    } finally {
      await cleanup();
    }
  });
});

describe('batching guidance in the system prompt (AC-15.5)', () => {
  it('WORKFLOW instructs multiple tool calls per response', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const prompt = await buildSystemPrompt(repo, await loadConfig(repo), {});
      expect(prompt).toContain('issue them together in a single reply');
      expect(prompt).toContain('resolutions: [...]');
    } finally {
      await cleanup();
    }
  });
});

describe('Anthropic prompt caching (AC-15.14, AC-15.15)', () => {
  it('marks three cache_control breakpoints and counts cached tokens', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 },
    });
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class {
        messages = { create };
      },
    }));
    try {
      const { AnthropicProvider } = await import('../src/agent/providers/anthropic.js');
      const provider = new AnthropicProvider('claude-sonnet-5', 'test-key');
      const tools: ToolSchema[] = [
        { name: 'a', description: 'a', parameters: { type: 'object', properties: {}, required: [] } },
        { name: 'b', description: 'b', parameters: { type: 'object', properties: {}, required: [] } },
      ];
      const messages: Msg[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, toolCalls: [{ id: 't1', name: 'a', args: {} }] },
        { role: 'tool', toolCallId: 't1', content: 'result' },
      ];
      const turn = await provider.chat(messages, tools);

      const req = create.mock.calls[0]![0] as {
        system: { cache_control?: unknown }[];
        tools: { name: string; cache_control?: unknown }[];
        messages: { content: { cache_control?: unknown }[] }[];
      };
      expect(req.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
      expect(req.tools[0]!.cache_control).toBeUndefined();
      expect(req.tools[1]!.cache_control).toEqual({ type: 'ephemeral' });
      const lastMsg = req.messages[req.messages.length - 1]!;
      const lastBlock = lastMsg.content[lastMsg.content.length - 1]!;
      expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
      const breakpoints = JSON.stringify(req).match(/"cache_control"/g) ?? [];
      expect(breakpoints).toHaveLength(3);
      expect(turn.usage.inputTokens).toBe(105);
      expect(turn.usage.outputTokens).toBe(2);
    } finally {
      vi.doUnmock('@anthropic-ai/sdk');
    }
  });
});

describe('per-stage turn budgets (AC-15.18, AC-15.19)', () => {
  it('loadConfig parses stageMaxTurns and omits it when absent', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect((await loadConfig(repo)).stageMaxTurns).toBeUndefined();
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        // zero/negative/non-integer entries are config typos: dropped on load
        // so a stage cannot start with an already-exhausted budget
        JSON.stringify({ maxTurns: 40, stageMaxTurns: { 'spec-seed': 60, architecture: 0, layout: -5, docs: 1.5 } }),
        'utf8',
      );
      const config = await loadConfig(repo);
      expect(config.maxTurns).toBe(40);
      expect(config.stageMaxTurns).toEqual({ 'spec-seed': 60 });
    } finally {
      await cleanup();
    }
  });
});

describe('empty-completion tolerance (agent loop)', () => {
  it('sporadic tool-less turns between productive ones do not fail the run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'docs'], { cwd: repo });
      // Three empty completions spread across productive turns — observed
      // live from a provider mid-run. Only consecutive stalls may fail.
      const provider = scriptedProvider([
        {},
        { toolCalls: [readCall] },
        {},
        { toolCalls: [readCall] },
        {},
        { toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'done' } }] },
      ]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider,
        maxTurns: 10,
        log: () => {},
      });
      expect(res.outcome).toBe('success');
      // each empty turn still got the continue-or-finish nudge
      const nudged = provider.seen
        .flat()
        .filter((m) => m.role === 'user' && (m as { content: string }).content.includes('Continue using tools'));
      expect(nudged.length).toBeGreaterThanOrEqual(3);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('three consecutive tool-less turns still fail the run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'docs'], { cwd: repo });
      const provider = scriptedProvider([{ toolCalls: [readCall] }, {}]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider,
        maxTurns: 10,
        log: () => {},
      });
      expect(res.outcome).toBe('failure');
      expect(res.summary).toContain('stopped calling tools');
    } finally {
      await cleanup();
    }
  }, 60_000);
});

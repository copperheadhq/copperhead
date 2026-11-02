import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  computeBudgetEscalation,
  isInsufficientTurnsRefusal,
  MAX_INSUFFICIENT_TURN_ESCALATIONS,
  runAgentLoop,
} from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { tempFixtureRepo } from './helpers.js';

const SYMLIB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'symlib');

class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  private index = 0;
  /** What the loop sent on each call, copied (the loop keeps mutating its array). */
  readonly seen: Msg[][] = [];

  constructor(
    private readonly turns: Turn[],
    private readonly beforeTurn?: (index: number) => Promise<void>,
  ) {}

  async chat(messages: Msg[]): Promise<Turn> {
    this.seen.push(messages.map((message) => ({ ...message })));
    await this.beforeTurn?.(this.index);
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)]!;
    this.index++;
    return turn;
  }
}

const usage = { inputTokens: 10, outputTokens: 5 };

const finish = (outcome: 'done' | 'refuse', summary: string): Turn => ({
  text: null,
  toolCalls: [{ id: 'finish', name: 'finish', args: { outcome, summary } }],
  usage,
});

async function events(transcriptDir: string): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const text = await readFile(path.join(transcriptDir, 'transcript.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('issue #446 insufficient-turn refusal handling', () => {
  it('recognizes turn-budget refusals without matching genuine design refusals', () => {
    expect(isInsufficientTurnsRefusal("I can't finish a valid BOM in the turns left")).toBe(true);
    expect(isInsufficientTurnsRefusal('Insufficient turns remain to finish')).toBe(true);
    expect(isInsufficientTurnsRefusal('design gap: the footprint is unavailable')).toBe(false);
    expect(isInsufficientTurnsRefusal('invalid input: malformed BOM row')).toBe(false);
  });

  it('recognizes the turn-budget and remaining-turns phrasings (patterns 4 and 5)', () => {
    expect(isInsufficientTurnsRefusal('the turn budget is too small for 283 rows')).toBe(true);
    expect(isInsufficientTurnsRefusal('Turn budget: not enough to verify every footprint')).toBe(true);
    expect(isInsufficientTurnsRefusal('remaining turns are too few to finish the BOM')).toBe(true);
    expect(isInsufficientTurnsRefusal('the remaining turns are insufficient')).toBe(true);
    // the qualifier must follow the subject: a budget that is fine is no refusal
    expect(isInsufficientTurnsRefusal('the turn budget was fine; the footprint is missing')).toBe(false);
    expect(isInsufficientTurnsRefusal(undefined)).toBe(false);
    expect(isInsufficientTurnsRefusal('')).toBe(false);
  });

  it('extends the budget and continues after an insufficient-turn refusal when the caller opts in', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = new ScriptedProvider([
        finish('refuse', "I can't finish a valid BOM in the turns left"),
        finish('done', 'finished after extension'),
      ]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'part selection',
        model: 'gpt-5',
        provider,
        maxTurns: 1,
        escalateInsufficientTurnRefusals: true,
        log: () => {},
      });

      expect(res.outcome).toBe('success');
      expect(res.stats.turnsUsed).toBe(2);
      const log = await events(res.transcriptDir);
      const extension = log.find((event) => event.type === 'budget-extended');
      expect(extension?.data.reason).toBe('insufficient-turns-refusal');
      expect(extension?.data.extraTurns).toBe(computeBudgetEscalation(1));
      // the continuation message is stage-neutral: no other stage hears about part selection
      const nudge = provider.seen[1]!.filter((message) => message.role === 'user').at(-1)!;
      expect(nudge.content).toContain('continue the task');
      expect(nudge.content).not.toMatch(/part-selection/i);
    } finally {
      await cleanup();
    }
  });

  it('without the opt-in, an insufficient-turn refusal still refuses and rolls back', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const scratch = path.join(repo, 'scratch-note.md');
      const provider = new ScriptedProvider([finish('refuse', 'not enough turns to finish the rename')], async (index) => {
        // a side effect of the attempt, which the refusal's rollback must remove
        if (index === 0) await writeFile(scratch, 'partial work\n', 'utf8');
      });
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'rename a net',
        model: 'gpt-5',
        provider,
        maxTurns: 1,
        log: () => {},
      });

      expect(res.outcome).toBe('refused');
      expect(res.exitPath).toBe('refused');
      expect(existsSync(scratch)).toBe(false);
      const log = await events(res.transcriptDir);
      expect(log.some((event) => event.type === 'budget-extended')).toBe(false);
      expect(log.some((event) => event.type === 'run-refused')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('leaves genuine design-gap refusals unchanged', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'part selection',
        model: 'gpt-5',
        provider: new ScriptedProvider([finish('refuse', 'design gap: the requested footprint is not installed')]),
        maxTurns: 1,
        escalateInsufficientTurnRefusals: true,
        log: () => {},
      });

      expect(res.outcome).toBe('refused');
      expect(res.exitPath).toBe('refused');
      expect((await events(res.transcriptDir)).some((event) => event.type === 'budget-extended')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('stops after the configured escalation cap', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const refused = finish('refuse', 'not enough turns to complete the BOM');
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'part selection',
        model: 'gpt-5',
        provider: new ScriptedProvider([refused]),
        maxTurns: 1,
        escalateInsufficientTurnRefusals: true,
        log: () => {},
      });

      expect(res.outcome).toBe('failure');
      expect(res.exitPath).toBe('turn-budget-exhausted');
      const log = await events(res.transcriptDir);
      expect(log.filter((event) => event.type === 'budget-extended')).toHaveLength(MAX_INSUFFICIENT_TURN_ESCALATIONS);
      expect(log.some((event) => event.type === 'budget-escalation-cap-hit')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('preserves the existing callback behavior for turn-budget exhaustion', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = new ScriptedProvider([
        { text: null, toolCalls: [{ id: 'unknown', name: 'not_a_tool', args: {} }], usage },
        finish('done', 'completed'),
      ]);
      let callbackCalls = 0;
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'continue',
        model: 'gpt-5',
        provider,
        maxTurns: 1,
        onBudgetExhausted: async () => {
          callbackCalls++;
          return 1;
        },
        log: () => {},
      });

      expect(res.outcome).toBe('success');
      expect(callbackCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

describe('issue #446 onToolResult observer', () => {
  const search: Turn = {
    text: null,
    toolCalls: [{ id: 'search', name: 'search_symbols', args: { query: 'MCU8' } }],
    usage,
  };

  it('receives the real dispatched tool result', async () => {
    vi.stubEnv('KICAD_SYMBOL_DIR', SYMLIB);
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const seen: Array<{ name: string; args: Record<string, unknown>; result: string; ok: boolean }> = [];
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'look up a symbol',
        model: 'gpt-5',
        provider: new ScriptedProvider([search, finish('refuse', 'design gap: stop here')]),
        maxTurns: 4,
        onToolResult: (name, args, result, ok) => {
          seen.push({ name, args, result, ok });
        },
        log: () => {},
      });

      expect(res.outcome).toBe('refused');
      const call = seen.find((entry) => entry.name === 'search_symbols');
      expect(call?.args).toEqual({ query: 'MCU8' });
      expect(call?.ok).toBe(true);
      expect(call?.result).toContain('installed symbols matching "MCU8"');
      expect(call?.result).toContain('CopperMCU:MCU8');
    } finally {
      await cleanup();
    }
  });

  it('a throwing callback is logged and the run still ends through its normal path', async () => {
    vi.stubEnv('KICAD_SYMBOL_DIR', SYMLIB);
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const scratch = path.join(repo, 'scratch-note.md');
      const provider = new ScriptedProvider([search, finish('refuse', 'design gap: stop here')], async (index) => {
        if (index === 0) await writeFile(scratch, 'partial work\n', 'utf8');
      });
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'look up a symbol',
        model: 'gpt-5',
        provider,
        maxTurns: 4,
        onToolResult: async () => {
          throw new Error('EPERM: rename part-cache.json');
        },
        log: () => {},
      });

      expect(res.outcome).toBe('refused');
      expect(res.exitPath).toBe('refused');
      expect(existsSync(scratch)).toBe(false); // the rollback still ran
      const log = await events(res.transcriptDir);
      const error = log.find((event) => event.type === 'tool-result-callback-error');
      expect(error?.data).toEqual({ name: 'search_symbols', error: 'EPERM: rename part-cache.json' });
      expect(log.some((event) => event.type === 'tool')).toBe(true);
      expect(log.some((event) => event.type === 'run-end')).toBe(true);
      expect(existsSync(path.join(res.transcriptDir, 'summary.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

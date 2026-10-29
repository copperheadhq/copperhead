import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  computeBudgetEscalation,
  isInsufficientTurnsRefusal,
  MAX_INSUFFICIENT_TURN_ESCALATIONS,
  runAgentLoop,
} from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { tempFixtureRepo } from './helpers.js';

class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  private index = 0;

  constructor(private readonly turns: Turn[]) {}

  async chat(_messages: Msg[]): Promise<Turn> {
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)]!;
    this.index++;
    return turn;
  }
}

const finish = (outcome: 'done' | 'refuse', summary: string): Turn => ({
  text: null,
  toolCalls: [{ id: 'finish', name: 'finish', args: { outcome, summary } }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

async function events(transcriptDir: string): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const text = await readFile(path.join(transcriptDir, 'transcript.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
}

describe('issue #446 insufficient-turn refusal handling', () => {
  it('recognizes turn-budget refusals without matching genuine design refusals', () => {
    expect(isInsufficientTurnsRefusal("I can't finish a valid BOM in the turns left")).toBe(true);
    expect(isInsufficientTurnsRefusal('Insufficient turns remain to finish')).toBe(true);
    expect(isInsufficientTurnsRefusal('design gap: the footprint is unavailable')).toBe(false);
    expect(isInsufficientTurnsRefusal('invalid input: malformed BOM row')).toBe(false);
  });

  it('extends the budget and continues after an insufficient-turn refusal', async () => {
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
        log: () => {},
      });

      expect(res.outcome).toBe('success');
      expect(res.stats.turnsUsed).toBe(2);
      const log = await events(res.transcriptDir);
      const extension = log.find((event) => event.type === 'budget-extended');
      expect(extension?.data.reason).toBe('insufficient-turns-refusal');
      expect(extension?.data.extraTurns).toBe(computeBudgetEscalation(1));
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
        { text: null, toolCalls: [{ id: 'unknown', name: 'not_a_tool', args: {} }], usage: { inputTokens: 10, outputTokens: 5 } },
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

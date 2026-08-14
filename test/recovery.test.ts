import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { withTimeout, TurnTimeoutError, parseDiagnosis, diagnoseStageFailure } from '../src/agent/recovery.js';
import { CachingProvider } from '../src/agent/response-cache.js';
import type { Msg, Provider, ToolSchema, Turn } from '../src/agent/types.js';

function turn(text: string): Turn {
  return { text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 20 } };
}

/** Records how many times chat() actually reached the model. */
class CountingProvider implements Provider {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly reply: (n: number) => Turn) {}
  async chat(): Promise<Turn> {
    return this.reply(++this.calls);
  }
}

const msgs: Msg[] = [{ role: 'user', content: 'hi' }];
const tools: ToolSchema[] = [];

describe('withTimeout (turn watchdog)', () => {
  it('returns the value when the call finishes in time', async () => {
    expect(await withTimeout(() => Promise.resolve(42), 1000)).toBe(42);
  });

  it('rejects with TurnTimeoutError and fires onTimeout when the deadline passes', async () => {
    let cleaned = false;
    const hang = new Promise<number>(() => {}); // never resolves
    await expect(withTimeout(() => hang, 30, () => { cleaned = true; })).rejects.toBeInstanceOf(TurnTimeoutError);
    expect(cleaned).toBe(true);
  });

  it('disables the watchdog when ms <= 0 (awaits the call)', async () => {
    expect(await withTimeout(() => Promise.resolve('ok'), 0)).toBe('ok');
  });
});

describe('parseDiagnosis', () => {
  it('parses a retry verdict with guidance, even wrapped in prose', async () => {
    const d = parseDiagnosis('Sure — here is my call:\n{"verdict":"retry","reason":"dropped edit","guidance":"apply the edit"}\ndone');
    expect(d.verdict).toBe('retry');
    expect(d.reason).toBe('dropped edit');
    expect(d.guidance).toBe('apply the edit');
  });

  it('parses an abort verdict and ignores guidance', () => {
    const d = parseDiagnosis('{"verdict":"abort","reason":"missing inputs","guidance":"n/a"}');
    expect(d.verdict).toBe('abort');
    expect(d.guidance).toBeUndefined();
  });

  it('fails safe to abort on non-JSON or missing verdict', () => {
    expect(parseDiagnosis('no json here').verdict).toBe('abort');
    expect(parseDiagnosis(null).verdict).toBe('abort');
    expect(parseDiagnosis('{"reason":"x"}').verdict).toBe('abort');
  });
});

describe('diagnoseStageFailure', () => {
  it('asks the model with no tools and returns the parsed verdict', async () => {
    let sawTools: ToolSchema[] | undefined;
    const provider: Provider = {
      name: 'fake',
      async chat(_m, t) {
        sawTools = t;
        return turn('{"verdict":"retry","reason":"looks transient","guidance":"try again"}');
      },
    };
    const d = await diagnoseStageFailure(provider, {
      stageName: 'schematic',
      stageGoal: 'build it',
      failure: 'contract not met',
      excerpt: '[assistant] ...',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(d.verdict).toBe('retry');
    expect(sawTools).toEqual([]); // diagnosis is a tool-less turn
  });

  it('fails safe to abort when the provider throws', async () => {
    const provider: Provider = {
      name: 'boom',
      async chat() {
        throw new Error('no key');
      },
    };
    const d = await diagnoseStageFailure(provider, {
      stageName: 's', stageGoal: 'g', failure: 'f', excerpt: '', attempt: 1, maxAttempts: 2,
    });
    expect(d.verdict).toBe('abort');
  });

  it('classifies repeating tool argument parse/schema errors on retries as deterministic abort without calling the provider', async () => {
    let called = false;
    const provider: Provider = {
      name: 'fake',
      async chat() {
        called = true;
        return turn('{"verdict":"retry"}');
      },
    };

    const d = await diagnoseStageFailure(provider, {
      stageName: 'part-selection',
      stageGoal: 'select parts',
      failure: 'the run ended as "failure" (provider-error): Codex tool call call-dec-1 has invalid JSON arguments: Unexpected token at position 452',
      excerpt: '[assistant] calling decision_symbols...',
      attempt: 2,
      maxAttempts: 3,
    });

    expect(called).toBe(false); // fast-path without LLM call
    expect(d.verdict).toBe('abort');
    expect(d.reason).toContain('Deterministic parse/schema error');
    expect(d.reason).toContain('decision_symbols');
    expect(d.reason).toContain('452');
  });
});

describe('CachingProvider', () => {
  it('caches a response and replays it (no second model call), reporting zero usage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    try {
      const inner = new CountingProvider(() => turn('answer'));
      const cached = new CachingProvider(inner, dir);
      const first = await cached.chat(msgs, tools);
      const second = await cached.chat(msgs, tools);
      expect(first.text).toBe('answer');
      expect(second.text).toBe('answer');
      expect(inner.calls).toBe(1); // second served from cache
      expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0 }); // replay costs nothing
      expect(existsSync(path.join(dir, '.gitignore'))).toBe(true); // cache stays out of git
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses (calls the model again) when the conversation differs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    try {
      const inner = new CountingProvider((n) => turn(`answer ${n}`));
      const cached = new CachingProvider(inner, dir);
      await cached.chat(msgs, tools);
      await cached.chat([{ role: 'user', content: 'different' }], tools);
      expect(inner.calls).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not share cached turns across compat endpoints with the same model id', async () => {
    // A model id like "compat:llama-3.1-8b-instant" is not unique across hosts
    // (Groq, OpenRouter, etc. all serve overlapping model ids), so two
    // providers pointed at different endpoints must never replay each other's
    // cached turns even though modelId matches.
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    try {
      const groq = new CountingProvider(() => turn('groq answer'));
      const openrouter = new CountingProvider(() => turn('openrouter answer'));
      const cachedGroq = new CachingProvider(
        groq, dir, undefined, 'compat:llama-3.1-8b-instant', 'https://api.groq.com/openai/v1',
      );
      const cachedOpenrouter = new CachingProvider(
        openrouter, dir, undefined, 'compat:llama-3.1-8b-instant', 'https://openrouter.ai/api/v1',
      );
      const first = await cachedGroq.chat(msgs, tools);
      const second = await cachedOpenrouter.chat(msgs, tools);
      expect(first.text).toBe('groq answer');
      expect(second.text).toBe('openrouter answer'); // not replayed from groq's cache entry
      expect(groq.calls).toBe(1);
      expect(openrouter.calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hits a pre-upgrade cache entry for a non-compat model (key shape unchanged)', async () => {
    // Before baseURL existed in the key, a non-compat entry hashed exactly
    // {model, messages, tools}. Writing a file under that same hash and
    // confirming a fresh CachingProvider (no baseURL) still hits it proves the
    // key is byte-identical post-upgrade, so existing users' caches are not
    // stranded on the first run after upgrading.
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    try {
      const preUpgradeKey = createHash('sha256')
        .update(JSON.stringify({ model: 'gpt-5', messages: msgs, tools: tools.map((t) => t.name) }))
        .digest('hex');
      await writeFile(
        path.join(dir, `${preUpgradeKey}.json`),
        JSON.stringify(turn('pre-upgrade cached answer')),
        'utf8',
      );
      const inner = new CountingProvider(() => turn('fresh answer'));
      const cached = new CachingProvider(inner, dir, undefined, 'gpt-5'); // no baseURL: non-compat
      const result = await cached.chat(msgs, tools);
      expect(result.text).toBe('pre-upgrade cached answer');
      expect(inner.calls).toBe(0); // served from the pre-upgrade entry, not re-called
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

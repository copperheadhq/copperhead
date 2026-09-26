import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { withTimeout, withWatchdog, TurnTimeoutError, parseDiagnosis, diagnoseStageFailure } from '../src/agent/recovery.js';
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

describe('withWatchdog (inactivity deadline + hard cap)', () => {
  const hang = () => new Promise<never>(() => {});

  it('keeps a call alive past idleMs while it reports activity', async () => {
    const slow = (activity: () => void) =>
      new Promise<string>((resolve) => {
        const tick = setInterval(activity, 20);
        setTimeout(() => {
          clearInterval(tick);
          resolve('done');
        }, 300);
      });
    expect(await withWatchdog(slow, { idleMs: 100 })).toBe('done');
  });

  it('gives a call that reports no activity idleMs as a plain deadline', async () => {
    let cleaned = false;
    const err = await withWatchdog(hang, { idleMs: 50, onTimeout: () => { cleaned = true; } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnTimeoutError);
    expect((err as TurnTimeoutError).kind).toBe('idle');
    expect(cleaned).toBe(true);
  });

  it('fires the idle deadline once progress stops', async () => {
    const start = Date.now();
    let tick: ReturnType<typeof setInterval> | undefined;
    const stalls = (activity: () => void) => {
      tick = setInterval(activity, 20);
      setTimeout(() => clearInterval(tick), 150); // progress, then silence
      return hang();
    };
    const err = await withWatchdog(stalls, { idleMs: 80 }).catch((e: unknown) => e);
    clearInterval(tick);
    expect((err as TurnTimeoutError).kind).toBe('idle');
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });

  it('stops a call at the hard cap however much activity it reports', async () => {
    let cleaned = false;
    let tick: ReturnType<typeof setInterval> | undefined;
    const streamsForever = (activity: () => void) => {
      tick = setInterval(activity, 10);
      return hang();
    };
    const err = await withWatchdog(streamsForever, {
      idleMs: 60,
      maxMs: 150,
      onTimeout: () => {
        cleaned = true;
      },
    }).catch((e: unknown) => e);
    clearInterval(tick);
    expect(err).toBeInstanceOf(TurnTimeoutError);
    expect((err as TurnTimeoutError).kind).toBe('max');
    expect((err as TurnTimeoutError).ms).toBe(150);
    expect(cleaned).toBe(true);
  });

  it('settles on the timeout even when onTimeout rejects the call synchronously', async () => {
    // A provider whose close() rejects its in-flight call at once (a plain,
    // non-async chat) must still surface TurnTimeoutError, not the teardown error.
    let rejectCall!: (e: Error) => void;
    const call = () =>
      new Promise<never>((_, reject) => {
        rejectCall = reject;
      });
    const err = await withWatchdog(call, { idleMs: 30, onTimeout: () => rejectCall(new Error('closed')) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TurnTimeoutError);
  });

  it('never caps a call that has reported no progress: its idle deadline alone applies', async () => {
    const err = await withWatchdog(hang, { idleMs: 200, maxMs: 100 }).catch((e: unknown) => e);
    expect((err as TurnTimeoutError).kind).toBe('idle');
    expect((err as TurnTimeoutError).ms).toBe(200);
  });

  it('with the idle deadline off, does not cap a call that stays silent', async () => {
    const quiet = () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 250));
    expect(await withWatchdog(quiet, { idleMs: 0, maxMs: 100 })).toBe('done');
  });

  it('trips the cap as soon as progress arrives after the cap has come due', async () => {
    let progressed = false;
    const lateStarter = (activity: () => void) => {
      setTimeout(() => {
        progressed = true;
        activity();
      }, 150);
      return hang();
    };
    const err = await withWatchdog(lateStarter, { idleMs: 0, maxMs: 50 }).catch((e: unknown) => e);
    expect((err as TurnTimeoutError).kind).toBe('max');
    expect(progressed, 'the cap waited for the first progress rather than firing at 50 ms').toBe(true);
  });

  it('never caps a streaming call below its idle deadline', async () => {
    let tick: ReturnType<typeof setInterval> | undefined;
    const streams = (activity: () => void) => {
      tick = setInterval(activity, 10);
      return hang();
    };
    const err = await withWatchdog(streams, { idleMs: 150, maxMs: 50 }).catch((e: unknown) => e);
    clearInterval(tick);
    expect((err as TurnTimeoutError).kind).toBe('max');
    expect((err as TurnTimeoutError).ms).toBe(150);
  });

  it('disables both limits when <= 0', async () => {
    expect(await withWatchdog(async () => 'ok', { idleMs: 0, maxMs: 0 })).toBe('ok');
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

  it('regenerates a legacy name-only entry because its tool contract cannot be verified', async () => {
    // A tool name alone does not tell us which schema/description produced a
    // cached call. Old entries cannot safely stand in for the current contract.
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    try {
      const currentTools: ToolSchema[] = [{
        name: 'inspect', description: 'Inspect the current design', parameters: { type: 'object' },
      }];
      const preUpgradeKey = createHash('sha256')
        .update(JSON.stringify({ model: 'gpt-5', messages: msgs, tools: currentTools.map((t) => t.name) }))
        .digest('hex');
      await writeFile(
        path.join(dir, `${preUpgradeKey}.json`),
        JSON.stringify(turn('pre-upgrade cached answer')),
        'utf8',
      );
      const inner = new CountingProvider(() => turn('fresh answer'));
      const cached = new CachingProvider(inner, dir, undefined, 'gpt-5'); // no baseURL: non-compat
      const result = await cached.chat(msgs, currentTools);
      expect(result.text).toBe('fresh answer');
      expect(inner.calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

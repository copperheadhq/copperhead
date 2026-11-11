import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgentLoop } from '../src/agent/loop.js';
import {
  ClaudeCodeProvider,
  limitFacts,
  type AccountInfoLike,
  type QueryLike,
  type QueryMessage,
  type QueryRun,
} from '../src/agent/providers/claude-code.js';
import type { Msg, Provider } from '../src/agent/types.js';
import { limitWindowLabel, sessionLimit, sessionLimitMessage, type SessionLimitFacts } from '../src/util/retry.js';
import { tempFixtureRepo } from './helpers.js';

// session-limit-names-account (copperhead-cloud issue #212): a usage limit belongs to the
// account that was logged in, so the stop names it and gives the reset with its time zone.

const LIMIT_TEXT = "You've hit your session limit · resets 10:10am";
// 2026-11-11T10:10:00Z, in seconds, as the Agent SDK reports `resetsAt`
const RESET_S = Date.UTC(2026, 10, 11, 10, 10) / 1000;

const messages: Msg[] = [
  { role: 'system', content: 'You are copperhead.' },
  { role: 'user', content: 'do the thing' },
];

/** A fake `query` whose turn is rejected by a usage limit, as the SDK reports it. */
function limitedQuery(opts: { account?: () => Promise<AccountInfoLike>; events?: QueryMessage[]; error?: unknown } = {}): QueryLike {
  return () => {
    const stream = (async function* (): AsyncGenerator<QueryMessage> {
      for (const m of opts.events ?? [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: RESET_S, rateLimitType: 'five_hour' } }]) {
        yield m;
      }
      throw opts.error ?? new Error(LIMIT_TEXT);
    })();
    return (opts.account ? Object.assign(stream, { accountInfo: opts.account }) : stream) as QueryRun;
  };
}

async function thrownBy(query: QueryLike): Promise<Error & { sessionLimit?: SessionLimitFacts }> {
  const provider = new ClaudeCodeProvider(undefined, query);
  try {
    await provider.chat(messages, []);
  } catch (err) {
    return err as Error & { sessionLimit?: SessionLimitFacts };
  } finally {
    await provider.close();
  }
  throw new Error('the turn did not throw');
}

describe('sessionLimit with the facts a provider attached', () => {
  it('prefers the exact reset, the account and the window over the clock text', () => {
    const err = Object.assign(new Error(LIMIT_TEXT), {
      sessionLimit: { account: ' a@example.com ', resetsAtMs: RESET_S * 1000, window: 'five_hour' },
    });
    expect(sessionLimit(err)).toEqual({
      resetsAt: '2026-11-11 10:10 UTC',
      resetsAtIso: '2026-11-11T10:10:00.000Z',
      account: 'a@example.com',
      window: 'five_hour',
    });
  });

  it('falls back to the clock text when no facts are attached', () => {
    expect(sessionLimit(new Error(LIMIT_TEXT))).toEqual({ resetsAt: '10:10am', resetsAtIso: null, account: null, window: null });
    const partial = Object.assign(new Error(LIMIT_TEXT), { sessionLimit: { account: '', resetsAtMs: Number.NaN, window: null } });
    expect(sessionLimit(partial)).toEqual({ resetsAt: '10:10am', resetsAtIso: null, account: null, window: null });
  });

  it('attached facts never turn another error into a limit', () => {
    const err = Object.assign(new Error('ECONNRESET'), { sessionLimit: { account: 'a@example.com' } });
    expect(sessionLimit(err)).toBeNull();
  });
});

describe('sessionLimitMessage', () => {
  it('names the account, the window and the reset in UTC, and says a switched account can re-run now', () => {
    const msg = sessionLimitMessage('claude-code', {
      resetsAt: '2026-11-11 10:10 UTC',
      resetsAtIso: '2026-11-11T10:10:00.000Z',
      account: 'a@example.com',
      window: 'five_hour',
    });
    expect(msg).toBe(
      'claude-code session/usage limit reached on a@example.com (5-hour limit, resets 2026-11-11 10:10 UTC). ' +
        'This is a schedulable pause, not a bug. The limit belongs to that account. ' +
        'If you have switched claude-code to another account, re-run the same command now; otherwise re-run it after the reset. ' +
        'Completed turns replay from the cache at ~0 tokens and the run resumes where it left off.',
    );
    expect(msg).not.toContain('Wait for the reset');
  });

  it('says the clock text has no time zone, and still says whose limit it is, without an account', () => {
    const msg = sessionLimitMessage('claude-code', { resetsAt: '10:10am', resetsAtIso: null, account: null, window: null });
    expect(msg).toContain('(resets 10:10am as the provider stated it, with no time zone)');
    expect(msg).toContain('The limit belongs to the account that was logged in when it hit.');
    expect(msg).toContain('re-run the same command now');
  });

  it('reads with no reset time at all', () => {
    const msg = sessionLimitMessage('codex', { resetsAt: null, resetsAtIso: null, account: null, window: null });
    expect(msg.startsWith('codex session/usage limit reached. This is a schedulable pause')).toBe(true);
  });

  it('words the windows', () => {
    expect(limitWindowLabel('five_hour')).toBe('5-hour');
    expect(limitWindowLabel('seven_day')).toBe('weekly');
    expect(limitWindowLabel('seven_day_opus')).toBe('weekly');
    expect(limitWindowLabel('overage')).toBe('overage');
    expect(limitWindowLabel(null)).toBeNull();
  });
});

describe('claude-code attaches who hit the limit', () => {
  it('reads the account from the query and the reset from the rejected limit event', async () => {
    const err = await thrownBy(limitedQuery({ account: async () => ({ email: 'a@example.com', organization: 'Acme' }) }));
    expect(err.message).toBe(LIMIT_TEXT);
    expect(err.sessionLimit).toEqual({ account: 'a@example.com', resetsAtMs: RESET_S * 1000, window: 'five_hour' });
    expect(sessionLimit(err)?.resetsAt).toBe('2026-11-11 10:10 UTC');
  });

  it('names the organization when the account has no email', async () => {
    const err = await thrownBy(limitedQuery({ account: async () => ({ organization: 'Acme' }) }));
    expect(err.sessionLimit?.account).toBe('Acme');
  });

  it('reports without an account when the SDK cannot say, and without a reset when no event rejected', async () => {
    const allowed: QueryMessage[] = [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: RESET_S, rateLimitType: 'seven_day' } }];
    expect((await thrownBy(limitedQuery({ events: allowed }))).sessionLimit).toEqual({ account: null, resetsAtMs: null, window: null });
    const failing = limitedQuery({ account: () => Promise.reject(new Error('control request failed')) });
    expect((await thrownBy(failing)).sessionLimit?.account).toBeNull();
    const throwing = limitedQuery({
      account: () => {
        throw new Error('not in this mode');
      },
    });
    expect((await thrownBy(throwing)).sessionLimit?.account).toBeNull();
  });

  it('does not wait on an account that never answers', async () => {
    const started = Date.now();
    const err = await thrownBy(limitedQuery({ account: () => new Promise<AccountInfoLike>(() => {}) }));
    expect(err.sessionLimit).toEqual({ account: null, resetsAtMs: RESET_S * 1000, window: 'five_hour' });
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);

  it('leaves any other error as it was thrown, a 429 included', async () => {
    const account = async () => ({ email: 'a@example.com' });
    const other = await thrownBy(limitedQuery({ account, error: new Error('ECONNRESET') }));
    expect(other.sessionLimit).toBeUndefined();
    const rateLimited = await thrownBy(limitedQuery({ account, error: Object.assign(new Error('usage limit'), { status: 429 }) }));
    expect(rateLimited.sessionLimit).toBeUndefined();
    expect((rateLimited as { status?: number }).status).toBe(429);
  });

  it('keeps a reset already in milliseconds', () => {
    expect(limitFacts('a@example.com', { status: 'rejected', resetsAt: RESET_S * 1000 }).resetsAtMs).toBe(RESET_S * 1000);
    expect(limitFacts(null, null)).toEqual({ account: null, resetsAtMs: null, window: null });
  });
});

describe('a run that stops on a usage limit', () => {
  it('names the account in the outcome, the JSON result and the transcript', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const provider: Provider = new ClaudeCodeProvider(undefined, limitedQuery({ account: async () => ({ email: 'a@example.com' }) }));
    try {
      const lines: string[] = [];
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'rename the status net',
        model: 'claude-code',
        provider,
        log: (l) => lines.push(l),
        meta: { command: 'do', modelSource: 'flag', version: '9.9.9', kicadCliVersion: '9.0.0' },
      });
      expect(res.outcome).toBe('failure');
      expect(res.exitPath).toBe('session-limit');
      expect(res.sessionLimit).toEqual({
        resetsAt: '2026-11-11 10:10 UTC',
        resetsAtIso: '2026-11-11T10:10:00.000Z',
        account: 'a@example.com',
        window: 'five_hour',
      });
      expect(res.summary).toContain('limit reached on a@example.com (5-hour limit, resets 2026-11-11 10:10 UTC)');
      expect(res.summary).toContain('If you have switched claude-code to another account, re-run the same command now');
      expect(JSON.parse(JSON.stringify(res)).sessionLimit.account).toBe('a@example.com');

      const raw = await readFile(path.join(res.transcriptDir, 'transcript.jsonl'), 'utf8');
      const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
      expect(events.find((e) => e.type === 'session-limit')?.data).toEqual({
        resetsAt: '2026-11-11 10:10 UTC',
        resetsAtIso: '2026-11-11T10:10:00.000Z',
        account: 'a@example.com',
        window: 'five_hour',
        provider: 'claude-code',
      });
      expect(lines.join('\n')).toContain('limit reached on a@example.com');
    } finally {
      await cleanup();
    }
  }, 60_000);
});

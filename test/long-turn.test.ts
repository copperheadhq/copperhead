import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop, type RunResult } from '../src/agent/loop.js';
import { ClaudeCodeProvider, type QueryLike, type QueryMessage } from '../src/agent/providers/claude-code.js';
import { plainRenderer, type ProgressRenderer } from '../src/agent/render.js';
import { DEFAULTS } from '../src/config.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * Turns longer than the 10-minute watchdog, simulated end to end: the real loop,
 * the real ClaudeCodeProvider and the shipped default timeouts. Only the Agent
 * SDK's `query` is replaced, by a fake `claude` subprocess that streams on a fake
 * clock and rejects on abort like the real SDK. Fake timers run an hour of
 * wall-clock in seconds; real I/O (git snapshot, the provider's scratch cwd,
 * transcript) still runs for real between clock advances. Abort times are
 * measured from the loop's own turn start, so they are exact however long that
 * real I/O takes.
 */

const MIN = 60_000;
/** Simulated time added per clock step while the fake subprocess waits (see `simulate`). */
const STEP_MS = 250;

interface SubprocessLog {
  calls: number;
  /** Simulated time at which each aborted call saw its abort. */
  abortedAt: number[];
}

type Step = { afterMs: number; msg: QueryMessage };

const streamEvent = (type: string, delta?: { type: string; text: string }): QueryMessage => ({
  type: 'stream_event',
  event: { type, ...(delta ? { delta } : {}) },
});
const textDelta = (text: string): QueryMessage => streamEvent('content_block_delta', { type: 'text_delta', text });
const assistant = (text: string): QueryMessage => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result: QueryMessage = { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 50 } };

/** Opens the response at once, streams a 100-char chunk every 30s for
 *  `minutes`, then completes the reply. */
function streamingFor(minutes: number): Step[] {
  const chunks = minutes * 2;
  const steps: Step[] = [{ afterMs: 0, msg: streamEvent('message_start') }];
  for (let i = 0; i < chunks; i++) steps.push({ afterMs: 30_000, msg: textDelta('x'.repeat(100)) });
  steps.push({ afterMs: 0, msg: assistant('x'.repeat(100 * chunks)) }, { afterMs: 0, msg: result });
  return steps;
}

/** Fake sleeps currently waiting on the simulated clock (see `simulate`). */
let pendingSleeps = 0;

/** Wait `ms` of simulated time, rejecting like the SDK if `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal | undefined, onAbort: () => void): Promise<void> {
  pendingSleeps++;
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      pendingSleeps--;
      onAbort();
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      pendingSleeps--;
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** A fake `query`: each call plays `script(call)` on the simulated clock. */
function fakeClaudeSubprocess(script: (call: number) => Step[], log: SubprocessLog): QueryLike {
  return (args) => {
    const call = ++log.calls;
    const signal = args.options?.abortController?.signal;
    return (async function* () {
      for (const step of script(call)) {
        if (step.afterMs > 0) await sleep(step.afterMs, signal, () => log.abortedAt.push(Date.now()));
        yield step.msg;
      }
    })();
  };
}

/** Run `start()` under fake timers until it settles. The clock moves, STEP_MS at a
 *  time, only while the fake subprocess is waiting on its schedule. The rest of
 *  the time the run is doing real I/O (git, the transcript, the provider's scratch
 *  cwd), and advancing the clock then would spend simulated time on it, making the
 *  result depend on how fast that I/O is. */
async function simulate<T>(start: () => Promise<T>, maxSimulatedMs = 3 * 60 * MIN): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  pendingSleeps = 0;
  try {
    let done = false;
    const run = start().finally(() => {
      done = true;
    });
    run.catch(() => {}); // surfaced by the await below, not as an unhandled rejection
    let simulated = 0;
    while (!done) {
      await new Promise((r) => setImmediate(r));
      if (pendingSleeps === 0) continue;
      if (simulated > maxSimulatedMs) throw new Error(`still running after ${maxSimulatedMs}ms of simulated time`);
      await vi.advanceTimersByTimeAsync(STEP_MS);
      simulated += STEP_MS;
    }
    return await run;
  } finally {
    vi.useRealTimers();
  }
}

async function runLoop(query: QueryLike): Promise<{ res: RunResult; lines: string[]; turnStartedAt: number[] }> {
  const { repo, cleanup } = await tempFixtureRepo();
  const lines: string[] = [];
  const turnStartedAt: number[] = [];
  const plain = plainRenderer((l) => lines.push(l));
  // The loop calls turnStart synchronously right before it arms the watchdog,
  // and the fake clock cannot move inside synchronous code, so this reading is
  // exactly the watchdog's start.
  const renderer: ProgressRenderer = {
    ...plain,
    turnStart: (...args) => {
      turnStartedAt.push(Date.now());
      plain.turnStart(...args);
    },
  };
  try {
    const res = await simulate(() =>
      runAgentLoop({
        repoRoot: repo,
        request: 'simulated long turn',
        model: 'claude-code',
        provider: new ClaudeCodeProvider(undefined, query),
        log: (l) => lines.push(l),
        renderer,
        meta: { command: 'do', modelSource: 'flag', version: '9.9.9', kicadCliVersion: '9.0.0' },
        maxTurns: 1,
        allowDirty: true,
      }),
    );
    return { res, lines, turnStartedAt };
  } finally {
    await cleanup();
  }
}

describe('turns longer than 10 minutes (simulated claude-code, shipped defaults)', () => {
  it('uses the shipped defaults: a 10-minute inactivity limit and a 60-minute cap', () => {
    expect(DEFAULTS.turnTimeoutMs).toBe(10 * MIN);
    expect(DEFAULTS.turnMaxMs).toBe(60 * MIN);
  });

  it('a 25-minute turn that keeps streaming completes on the first attempt', async () => {
    const log: SubprocessLog = { calls: 0, abortedAt: [] };
    const { res, lines, turnStartedAt } = await runLoop(fakeClaudeSubprocess(() => streamingFor(25), log));
    expect(log.calls).toBe(1);
    expect(turnStartedAt).toHaveLength(1);
    expect(log.abortedAt).toEqual([]);
    expect(res.stats.durationMs).toBeGreaterThanOrEqual(25 * MIN);
    expect(lines.some((l) => /retrying|turnTimeoutMs|turnMaxMs/.test(l))).toBe(false);
    // The heartbeat shows the turn alive and streaming well past the old limit.
    expect(lines.some((l) => l.includes('still working — 20m00s elapsed, ~') && l.includes('chars streamed'))).toBe(true);
  }, 60_000);

  it('a turn that goes silent is aborted exactly at the 10-minute mark and retried', async () => {
    const log: SubprocessLog = { calls: 0, abortedAt: [] };
    const script = (call: number): Step[] =>
      call === 1
        ? [{ afterMs: 11 * MIN, msg: assistant('too late') }, { afterMs: 0, msg: result }]
        : [{ afterMs: 5_000, msg: textDelta('ok') }, { afterMs: 0, msg: assistant('ok') }, { afterMs: 0, msg: result }];
    const { lines, turnStartedAt } = await runLoop(fakeClaudeSubprocess(script, log));
    expect(log.calls).toBe(2);
    expect(turnStartedAt).toHaveLength(2); // the turn, then its retry
    expect(log.abortedAt).toHaveLength(1);
    expect(log.abortedAt[0]! - turnStartedAt[0]!).toBe(DEFAULTS.turnTimeoutMs);
    expect(lines.some((l) => l.includes('retrying (1/3)'))).toBe(true);
  }, 60_000);

  it('a turn still streaming at 60 minutes is stopped exactly at the cap and not resent', async () => {
    const log: SubprocessLog = { calls: 0, abortedAt: [] };
    const { res, turnStartedAt } = await runLoop(fakeClaudeSubprocess(() => streamingFor(70), log));
    expect(log.calls).toBe(1);
    expect(turnStartedAt).toHaveLength(1);
    expect(log.abortedAt).toHaveLength(1);
    expect(log.abortedAt[0]! - turnStartedAt[0]!).toBe(DEFAULTS.turnMaxMs);
    expect(res.outcome).toBe('failure');
    expect(res.exitPath).toBe('provider-error');
    expect(res.summary).toContain('1h00m');
    expect(res.summary).toContain('too large, not hung');
  }, 60_000);
});

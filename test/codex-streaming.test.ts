import { afterEach, describe, expect, it, vi } from 'vitest';
import { Codex } from '@openai/codex-sdk';
import type { ThreadEvent } from '@openai/codex-sdk';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CodexProvider } from '../src/agent/providers/codex.js';
import { TurnTimeoutError, withWatchdog } from '../src/agent/recovery.js';

const final = JSON.stringify({ text: 'done', toolCalls: [] });
const end: ThreadEvent = { type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 4, cached_input_tokens: 0, reasoning_output_tokens: 1 } };
const text = (id: string, value: string, type: 'item.updated' | 'item.completed' = 'item.updated', itemType: 'reasoning' | 'agent_message' = 'reasoning'): ThreadEvent => ({ type, item: { id, type: itemType, text: value } });
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  function abort() { clearTimeout(timer); reject(new Error('aborted')); }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});
afterEach(() => vi.useRealTimers());

describe('Codex actual streaming progress', () => {
  it('counts only growing text, preserves final structured validation and usage', async () => {
    const progress = vi.fn(); const run = vi.fn();
    const provider = new CodexProvider({ workingDirectory: process.cwd(), client: { startThread: () => ({ run, runStreamed: async () => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'fake' } as ThreadEvent;
      yield { type: 'turn.started' } as ThreadEvent;
      yield text('r', 'abc'); yield text('r', 'abc'); yield text('r', 'ab'); yield text('r', 'abcde');
      yield text('a', final, 'item.completed', 'agent_message'); yield end;
    })() }) } ) } });
    const result = await provider.chat([{ role: 'user', content: 'test' }], [], { onStream: progress });
    expect(progress.mock.calls.map(x => x[0])).toEqual([3, 5, 5 + final.length]);
    expect(result).toEqual({ text: 'done', toolCalls: [], usage: { inputTokens: 9, outputTokens: 4 } });
    expect(run).not.toHaveBeenCalled(); await provider.close();
  });

  it('real text updates keep an actual watchdog alive beyond its idle window', async () => {
    vi.useFakeTimers();
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    const provider = new CodexProvider({ workingDirectory: process.cwd(), client: { startThread: () => ({ run: vi.fn(), runStreamed: async (_p, options) => { started(); return { events: (async function* () {
      for (let i = 1; i <= 4; i++) { await sleep(20, options?.signal); yield text('r', 'x'.repeat(i)); }
      yield text('a', final, 'item.completed', 'agent_message'); yield end;
    })() }; } }) } });
    const promise = withWatchdog(activity => provider.chat([], [], { onStream: () => activity() }), { idleMs: 35, maxMs: 200, onTimeout: () => provider.close() });
    const observed = promise.then(x => x, e => e);
    await ready; await vi.advanceTimersByTimeAsync(100);
    expect((await observed).text).toBe('done'); await provider.close();
  });

  it.each(['idle', 'max'] as const)('%s timeout aborts the iterator and closes its cleanup', async kind => {
    vi.useFakeTimers(); let cleaned = false; let signal: AbortSignal | undefined;
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    const provider = new CodexProvider({ workingDirectory: process.cwd(), client: { startThread: () => ({ run: vi.fn(), runStreamed: async (_p, options) => {
      signal = options?.signal;
      started();
      return { events: (async function* () { try {
        for (let i = 1; ; i++) { await sleep(20, signal);
          // Lifecycle notifications are not generation progress.
          yield kind === 'max' ? text('r', 'x'.repeat(i)) : { type: 'turn.started' } as ThreadEvent;
        }
      } finally { cleaned = true; } })() };
    } }) } });
    const observed = withWatchdog(activity => provider.chat([], [], { onStream: () => activity() }), { idleMs: 35, maxMs: 80, onTimeout: () => provider.close() }).catch(e => e);
    await ready; await vi.advanceTimersByTimeAsync(100);
    const error = await observed;
    expect(error).toBeInstanceOf(TurnTimeoutError); expect(error.kind).toBe(kind);
    expect(signal?.aborted).toBe(true); expect(cleaned).toBe(true); await provider.close();
  });

  it.each(['truncated', 'failed', 'error'])('rejects a %s stream without a schema-correction generation', async mode => {
    const runStreamed = vi.fn(async () => ({ events: (async function* () {
      yield text('a', final, 'item.completed', 'agent_message');
      if (mode === 'failed') yield { type: 'turn.failed', error: { message: 'provider failed' } } as ThreadEvent;
      if (mode === 'error') yield { type: 'error', message: 'stream error' } as ThreadEvent;
    })() }));
    const provider = new CodexProvider({ workingDirectory: process.cwd(), client: { startThread: () => ({ run: vi.fn(), runStreamed }) } });
    await expect(provider.chat([], [])).rejects.toThrow(mode === 'truncated' ? 'without turn.completed' : mode === 'failed' ? 'provider failed' : 'stream error');
    expect(runStreamed).toHaveBeenCalledTimes(1); await provider.close();
  });

  it('streams schema correction while summing usage and retaining the accepted cursor', async () => {
    const runStreamed = vi.fn().mockImplementationOnce(async () => ({ events: (async function* () { yield text('a', 'invalid', 'item.completed', 'agent_message'); yield end; })() }))
      .mockImplementationOnce(async () => ({ events: (async function* () { yield text('a', final, 'item.completed', 'agent_message'); yield end; })() }));
    const progress = vi.fn();
    const provider = new CodexProvider({ workingDirectory: process.cwd(), client: { startThread: () => ({ run: vi.fn(), runStreamed }) } });
    expect((await provider.chat([], [], { onStream: progress })).usage).toEqual({ inputTokens: 18, outputTokens: 8 });
    expect(progress.mock.calls.map(x => x[0])).toEqual([7, 7 + final.length]);
    expect(runStreamed.mock.calls[1]?.[0]).toContain('rejected your previous structured turn'); await provider.close();
  });

  it('official SDK aborts its real offline child process on close()', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codex-stream-cancel-'));
    const executable = path.join(root, 'fake-cli.py'); const stopped = path.join(root, 'stopped');
    await writeFile(executable, `#!/usr/bin/python3\nimport json,signal,time,sys\nfrom pathlib import Path\ndef stop(*args):\n Path(${JSON.stringify(stopped)}).write_text('terminated')\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint(json.dumps({'type':'turn.started'}),flush=True)\nprint(json.dumps({'type':'item.updated','item':{'id':'r','type':'reasoning','text':'real fake-child event'}}),flush=True)\ntime.sleep(100)\n`, { mode: 0o700 });
    const client = new Codex({ codexPathOverride: executable, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    const provider = new CodexProvider({ workingDirectory: root, client });
    try {
      let ready!: () => void; const started = new Promise<void>(r => { ready = r; });
      const observed = provider.chat([], [], { onStream: () => ready() }).catch(e => e);
      await Promise.race([started, observed.then(result => { throw result; })]); await provider.close();
      expect(await observed).toBeInstanceOf(Error);
      for (let i = 0; i < 20; i++) { try { if (await readFile(stopped, 'utf8') === 'terminated') break; } catch {} await sleep(10); }
      expect(await readFile(stopped, 'utf8')).toBe('terminated');
    } finally { await provider.close(); await rm(root, { recursive: true, force: true }); }
  }, 5000);
});

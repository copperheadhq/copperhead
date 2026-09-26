import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../src/agent/providers/openai.js';
import { AnthropicProvider } from '../src/agent/providers/anthropic.js';
import { ClaudeCodeProvider, type QueryArgs, type QueryLike } from '../src/agent/providers/claude-code.js';
import { CursorProvider, parseCursorStdout, type CursorRunArgs } from '../src/agent/providers/cursor.js';
import { CodexProvider } from '../src/agent/providers/codex.js';
import type { Msg, Provider } from '../src/agent/types.js';

const api = vi.hoisted(() => ({ create: vi.fn(), constructors: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    constructor(opts: unknown) { api.constructors(opts); }
    chat = { completions: { create: api.create } };
  },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(opts: unknown) { api.constructors(opts); }
    messages = { create: api.create };
  },
}));

const initial: Msg[] = [{ role: 'user', content: 'inspect the design' }];
const later: Msg[] = [...initial, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'continue' }];
const providers: Provider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close?.()));
  vi.clearAllMocks();
});

describe('keyed provider request lifecycle', () => {
  it.each(['openai', 'anthropic'])('%s cancels the request when the watchdog closes it', async (name) => {
    let signal: AbortSignal | undefined;
    api.create.mockImplementation((_body: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
      });
    });
    const provider: Provider = name === 'openai'
      ? new OpenAIProvider('test', undefined, { OPENAI_API_KEY: 'test-key' })
      : new AnthropicProvider('test', 'test-key');
    providers.push(provider);
    const pending = provider.chat(initial, []);
    const rejected = expect(pending).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
    expect(signal).toBeInstanceOf(AbortSignal);
    await provider.close?.();
    await rejected;
    expect(signal!.aborted).toBe(true);
    // The loop owns retries and failover; nested SDK retries multiply requests.
    expect(api.constructors).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });
});

describe('saved-login provider recovery', () => {
  it.each(['codex', 'claude-code', 'cursor'])(
    '%s gives a nested skill and its returning parent independent conversation histories', async (name) => {
      const seen: { prompt: string; resumed: boolean }[] = [];
      let provider: Provider;
      if (name === 'codex') {
        provider = new CodexProvider({ client: { startThread: () => {
          let turn = 0;
          return { run: async (prompt) => {
            seen.push({ prompt, resumed: turn++ > 0 });
            return { finalResponse: '{"text":"ok","toolCalls":[]}', usage: null };
          } };
        } } });
      } else if (name === 'claude-code') {
        provider = new ClaudeCodeProvider(undefined, (args) => (async function* () {
          seen.push({ prompt: args.prompt, resumed: Boolean(args.options?.resume) });
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
          yield { type: 'result', subtype: 'success', session_id: `session-${seen.length}` };
        })(), undefined, true);
      } else {
        provider = new CursorProvider(undefined, async (args) => {
          seen.push({ prompt: args.prompt, resumed: Boolean(args.resume) });
          return { text: 'ok', sessionId: `session-${seen.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
        }, true);
      }
      providers.push(provider);
      await provider.chat(initial, []);
      await provider.chat(later, []);
      expect(seen[1]!.resumed).toBe(true);
      // The shorter skill history used to be sliced past its own request.
      await provider.chat([{ role: 'user', content: 'generate a power report' }], []);
      expect(seen[2]!.resumed).toBe(false);
      expect(seen[2]!.prompt).toContain('generate a power report');
      await provider.chat([...later, { role: 'user', content: 'report completed' }], []);
      expect(seen[3]!.resumed).toBe(false);
      expect(seen[3]!.prompt).toContain('inspect the design');
      expect(seen[3]!.prompt).toContain('report completed');
    },
  );

  it('Claude Code discards an abandoned late turn and starts a fresh resumed session with full history', async () => {
    const seen: QueryArgs[] = [];
    let release: (() => void) | undefined;
    const query: QueryLike = (args) => {
      const turn = seen.push(args);
      return (async function* () {
        if (turn === 2) await new Promise<void>((resolve) => { release = resolve; });
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success', session_id: `session-${turn}` };
      })();
    };
    const provider = new ClaudeCodeProvider(undefined, query, undefined, true);
    providers.push(provider);
    await provider.chat(initial, []);
    const pending = provider.chat(later, []);
    const rejected = expect(pending).rejects.toThrow('closed');
    await vi.waitFor(() => expect(release).toBeDefined());
    await provider.close();
    release!();
    await rejected;
    await provider.chat(later, []);
    expect(seen[2]!.options?.resume).toBeUndefined();
    expect(seen[2]!.prompt).toContain('inspect the design');
    expect(seen[2]!.prompt).toContain('continue');
    expect(seen[2]!.options?.cwd).not.toBe(seen[1]!.options?.cwd);
  });

  it('Cursor discards an abandoned late turn and starts with full history after close', async () => {
    const seen: CursorRunArgs[] = [];
    let release: (() => void) | undefined;
    const provider = new CursorProvider(undefined, async (args) => {
      const turn = seen.push(args);
      if (turn === 2) await new Promise<void>((resolve) => { release = resolve; });
      return { text: 'ok', sessionId: `session-${turn}`, usage: { inputTokens: 1, outputTokens: 1 } };
    }, true);
    providers.push(provider);
    await provider.chat(initial, []);
    const pending = provider.chat(later, []);
    const rejected = expect(pending).rejects.toThrow('closed');
    await vi.waitFor(() => expect(release).toBeDefined());
    await provider.close();
    release!();
    await rejected;
    await provider.chat(later, []);
    expect(seen[2]!.resume).toBeUndefined();
    expect(seen[2]!.prompt).toContain('inspect the design');
    expect(seen[2]!.prompt).toContain('continue');
    expect(seen[2]!.workspace).not.toBe(seen[1]!.workspace);
  });

  it.each(['error_during_execution', 'error_max_turns', 'error_max_budget_usd'])(
    'Claude Code rejects %s even after a tool-shaped assistant response', async (subtype) => {
      const query: QueryLike = async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"tool":"finish","args":{}}' }] } };
        yield { type: 'result', subtype, is_error: true, errors: ['SDK stopped before completion'] };
      };
      const provider = new ClaudeCodeProvider(undefined, query);
      providers.push(provider);
      await expect(provider.chat(initial, [{ name: 'finish', description: '', parameters: { type: 'object' } }]))
        .rejects.toThrow('SDK stopped before completion');
    },
  );

  it('Cursor preserves an authentication error from pretty-printed result JSON', () => {
    const output = JSON.stringify({ type: 'result', is_error: true, result: 'not logged in, run agent login' }, null, 2);
    expect(() => parseCursorStdout(output)).toThrow('not logged in, run agent login');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LMStudioProvider,
  LMSTUDIO_DEFAULT_BASE_URL,
} from '../src/agent/providers/lmstudio.js';
import { OpenAIProvider, type ChatClientLike, type ChatRequestLike } from '../src/agent/providers/openai.js';
import { makeProvider } from '../src/agent/loop.js';
import { CachingProvider } from '../src/agent/response-cache.js';
import { isRateLimit } from '../src/util/retry.js';
import type { Msg, ToolSchema } from '../src/agent/types.js';

const tools: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file from the repo',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'finish',
    description: 'Finish the run',
    parameters: { type: 'object', properties: { outcome: { type: 'string' } } },
  },
];

const messages: Msg[] = [
  { role: 'system', content: 'You are copperhead.' },
  { role: 'user', content: 'do the thing' },
];

interface FakeOpts {
  /** Assistant text for the completion. */
  text?: string | null;
  /** Native tool calls to return. */
  toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** Model ids the server reports as loaded. */
  models?: string[];
  /** Thrown from chat.completions.create. */
  throws?: unknown;
  /** Thrown from models.list. */
  listThrows?: unknown;
  /** Records every request body sent. */
  onRequest?: (body: ChatRequestLike) => void;
  /** Counts models.list() calls. */
  onList?: () => void;
}

function fakeClient(o: FakeOpts = {}): ChatClientLike {
  return {
    chat: {
      completions: {
        async create(body: ChatRequestLike) {
          o.onRequest?.(body);
          if (o.throws) throw o.throws;
          return {
            choices: [
              {
                message: {
                  content: o.text ?? null,
                  ...(o.toolCalls ? { tool_calls: o.toolCalls } : {}),
                },
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          };
        },
      },
    },
    models: {
      async list() {
        o.onList?.();
        if (o.listThrows) throw o.listThrows;
        return { data: (o.models ?? ['qwen2.5-coder-32b-instruct']).map((id) => ({ id })) };
      },
    },
  };
}

function nativeCall(name: string, args: Record<string, unknown>) {
  return { id: 'call_1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } };
}

/** Error shaped like the openai SDK's APIConnectionError for a dead server. */
function connectionError(): Error {
  const err = new Error('Connection error.');
  err.name = 'APIConnectionError';
  (err as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), {
    code: 'ECONNREFUSED',
  });
  return err;
}

const ENV_KEYS = ['LMSTUDIO_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('LMStudioProvider — routing', () => {
  it('routes lmstudio and lmstudio:<id> to the local provider', async () => {
    const bare = await makeProvider('lmstudio');
    expect(bare).toBeInstanceOf(LMStudioProvider);
    expect(bare.name).toBe('lmstudio');

    const pinned = await makeProvider('lmstudio:qwen2.5-coder-32b');
    expect(pinned).toBeInstanceOf(LMStudioProvider);
  });

  it('rejects an empty model override', async () => {
    await expect(makeProvider('lmstudio:')).rejects.toThrow(/cannot be empty/);
  });

  it('leaves the OpenAI route alone', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const openai = await makeProvider('gpt-5');
    expect(openai).toBeInstanceOf(OpenAIProvider);
    expect(openai).not.toBeInstanceOf(LMStudioProvider);
    expect(openai.name).toBe('openai');
    // A model id that merely contains the substring must not be captured.
    expect((await makeProvider('gpt-5-mini')).name).toBe('openai');
  });
});

describe('LMStudioProvider — endpoint and credentials', () => {
  it('defaults to the LM Studio localhost endpoint', () => {
    expect(new LMStudioProvider().endpoint).toBe(LMSTUDIO_DEFAULT_BASE_URL);
    expect(LMSTUDIO_DEFAULT_BASE_URL).toBe('http://localhost:1234/v1');
  });

  it('honors LMSTUDIO_BASE_URL, and an explicit option beats the env var', () => {
    process.env.LMSTUDIO_BASE_URL = 'http://192.168.1.50:1234/v1';
    expect(new LMStudioProvider().endpoint).toBe('http://192.168.1.50:1234/v1');
    expect(new LMStudioProvider({ baseURL: 'http://localhost:11434/v1' }).endpoint).toBe(
      'http://localhost:11434/v1',
    );
  });

  it('treats a blank endpoint as unset instead of falling through to api.openai.com', async () => {
    // Regression: `??` preserves '', and the base class omits a falsy baseURL
    // from the SDK options, so an empty LMSTUDIO_BASE_URL sent a run the user
    // asked to keep local to the SDK default cloud host. .env.example ships this
    // key present-but-empty, which is exactly how it happened.
    for (const blank of ['', '   ']) {
      process.env.LMSTUDIO_BASE_URL = blank;
      expect(new LMStudioProvider().endpoint).toBe(LMSTUDIO_DEFAULT_BASE_URL);
      expect(new LMStudioProvider({ baseURL: blank }).endpoint).toBe(LMSTUDIO_DEFAULT_BASE_URL);
    }
    // and the URL the SDK client is actually built with is never a cloud host
    delete process.env.LMSTUDIO_BASE_URL;
    const provider = new LMStudioProvider({ baseURL: '  ' });
    const built = await (provider as unknown as { client(): Promise<{ baseURL?: string }> }).client();
    expect(built.baseURL).toBe(LMSTUDIO_DEFAULT_BASE_URL);
    expect(built.baseURL).not.toMatch(/openai\.com/);
  });

  it('constructs with no cloud API key set', () => {
    // The OpenAI provider cannot; that is the whole point of this one.
    expect(() => new OpenAIProvider()).toThrow(/OPENAI_API_KEY is not set/);
    expect(() => new LMStudioProvider()).not.toThrow();
  });

  it('never carries a cloud key to the local endpoint', async () => {
    process.env.OPENAI_API_KEY = 'sk-super-secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    const provider = new LMStudioProvider({ client: fakeClient({ text: 'ok' }) });
    await provider.chat(messages, tools);
    // The credential is a fixed placeholder, not read from the environment.
    const apiKey = (provider as unknown as { apiKey: string }).apiKey;
    expect(apiKey).toBe('lm-studio');
    expect(apiKey).not.toContain('secret');
  });
});

describe('LMStudioProvider — no fallback to a billed provider', () => {
  it('is not eligible for the keyed rate-limit failover even with both cloud keys set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    // otherProvider is module-private; its contract is keyed off provider.name,
    // so assert the property that makes it return null for us.
    const provider = new LMStudioProvider();
    expect(provider.name).toBe('lmstudio');
    expect(['openai', 'anthropic']).not.toContain(provider.name);
  });
});

describe('LMStudioProvider — model id resolution', () => {
  it('scopes cached turns to the configured endpoint', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-lmstudio-cache-'));
    let calls = 0;
    const inner = {
      name: 'lmstudio',
      async chat() {
        calls++;
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    try {
      const first = new LMStudioProvider({ model: 'same-model', baseURL: 'http://first.example/v1', client: fakeClient() });
      const second = new LMStudioProvider({ model: 'same-model', baseURL: 'http://second.example/v1', client: fakeClient() });
      await new CachingProvider(inner, dir, undefined, 'same-model', first.cacheKeyEndpoint()).chat(messages, tools);
      await new CachingProvider(inner, dir, undefined, 'same-model', second.cacheKeyEndpoint()).chat(messages, tools);
      expect(calls).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('probes the server once for a bare lmstudio and reuses the answer', async () => {
    let lists = 0;
    const sent: ChatRequestLike[] = [];
    const provider = new LMStudioProvider({
      client: fakeClient({
        text: 'ok',
        models: ['qwen2.5-coder-32b-instruct'],
        onList: () => lists++,
        onRequest: (b) => sent.push(b),
      }),
    });
    await provider.chat(messages, tools);
    await provider.chat(messages, tools);
    expect(lists).toBe(1);
    expect(sent.map((b) => b.model)).toEqual([
      'qwen2.5-coder-32b-instruct',
      'qwen2.5-coder-32b-instruct',
    ]);
  });

  it('errors actionably when the server has no model loaded', async () => {
    const provider = new LMStudioProvider({ client: fakeClient({ models: [] }) });
    await expect(provider.chat(messages, tools)).rejects.toThrow(/no model is loaded/);
  });

  it('exposes the discovered id so run metadata and the cache key record the real model', async () => {
    // The cache key and run metadata are built up front, before the first turn.
    // Without this hook both would record the routing string "lmstudio", so two
    // different local models would share cache entries (F6) and metadata could
    // not say which model designed the board.
    let lists = 0;
    const provider = new LMStudioProvider({
      client: fakeClient({ text: 'ok', models: ['google/gemma-4-12b'], onList: () => lists++ }),
    });
    expect(await provider.resolvedModelId?.()).toBe('google/gemma-4-12b');
    // and it is the same single probe the turns use
    await provider.chat(messages, tools);
    expect(lists).toBe(1);
  });

  it('reports the explicit id without probing, via the same hook', async () => {
    let lists = 0;
    const provider = new LMStudioProvider({
      model: 'llama-3.3-70b',
      client: fakeClient({ text: 'ok', onList: () => lists++ }),
    });
    expect(await provider.resolvedModelId?.()).toBe('llama-3.3-70b');
    expect(lists).toBe(0);
  });

  it('identifies when bare routing needs discovery, while an explicit id does not', () => {
    expect(new LMStudioProvider({ client: fakeClient() }).needsModelDiscovery()).toBe(true);
    expect(new LMStudioProvider({ model: 'llama-3.3-70b', client: fakeClient() }).needsModelDiscovery()).toBe(false);
  });

  it('never probes when the model id is given explicitly', async () => {
    let lists = 0;
    const sent: ChatRequestLike[] = [];
    const provider = new LMStudioProvider({
      model: 'llama-3.3-70b',
      client: fakeClient({ text: 'ok', onList: () => lists++, onRequest: (b) => sent.push(b) }),
    });
    await provider.chat(messages, tools);
    expect(lists).toBe(0);
    expect(sent[0]?.model).toBe('llama-3.3-70b');
  });
});

describe('LMStudioProvider — errors', () => {
  it('turns an unreachable server into an actionable message naming the endpoint', async () => {
    const provider = new LMStudioProvider({
      model: 'x',
      client: fakeClient({ throws: connectionError() }),
    });
    await expect(provider.chat(messages, tools)).rejects.toThrow(
      /no LM Studio server reachable at http:\/\/localhost:1234\/v1/,
    );
    await expect(provider.chat(messages, tools)).rejects.toThrow(/LMSTUDIO_BASE_URL/);
  });

  it('reports a model that cannot do tool calling, naming the configured endpoint', async () => {
    const err = Object.assign(new Error('400 model does not support tools'), { status: 400 });
    const provider = new LMStudioProvider({
      model: 'x',
      baseURL: 'http://localhost:11434/v1',
      client: fakeClient({ throws: err }),
    });
    await expect(provider.chat(messages, tools)).rejects.toThrow(/tool-capable model/);
    // an overridden host must be identifiable from the error alone
    await expect(provider.chat(messages, tools)).rejects.toThrow(/localhost:11434/);
  });

  // Every shape a dead endpoint can take. Only ECONNREFUSED was covered before;
  // a regression in any of the others turns the actionable message back into a
  // raw SDK error, which is the whole failure this diagnostic exists to prevent.
  const unreachable: Array<[string, () => unknown]> = [
    ['ECONNREFUSED on the cause', () => connectionError()],
    ['ENOTFOUND (bad hostname)', () => Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' })],
    ['ECONNRESET mid-request', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['EHOSTUNREACH (no route)', () => Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })],
    ['APIConnectionError by name', () => Object.assign(new Error('nope'), { name: 'APIConnectionError' })],
    [
      'APIConnectionTimeoutError by name',
      () => Object.assign(new Error('timed out'), { name: 'APIConnectionTimeoutError' }),
    ],
    ['message-only fallback', () => new Error('Connection error.')],
    ['fetch failed fallback', () => new Error('fetch failed')],
  ];
  for (const [label, make] of unreachable) {
    it(`treats ${label} as an unreachable server`, async () => {
      const provider = new LMStudioProvider({ model: 'x', client: fakeClient({ throws: make() }) });
      await expect(provider.chat(messages, tools)).rejects.toThrow(/no LM Studio server reachable/);
    });
  }

  it('does not mistake an answered request for a connection failure', async () => {
    // A numeric status means the server replied, so however the message reads it
    // is not a connectivity problem; misreporting it would hide a real 5xx.
    const err = Object.assign(new Error('connection error while proxying upstream'), { status: 502 });
    const provider = new LMStudioProvider({ model: 'x', client: fakeClient({ throws: err }) });
    await expect(provider.chat(messages, tools)).rejects.toBe(err);
  });

  it('re-throws a 400 that is not about tools, keeping its status', async () => {
    // Only tool/function-shaped 400s mean "model cannot do tool calling". An
    // unrelated 400 must survive untouched for retry classification.
    const err = Object.assign(new Error('400 context length exceeded'), { status: 400 });
    const provider = new LMStudioProvider({ model: 'x', client: fakeClient({ throws: err }) });
    await expect(provider.chat(messages, tools)).rejects.toBe(err);
    expect((err as { status: number }).status).toBe(400);
  });

  it('names the discovered model in the tool-calling error, not just the endpoint', async () => {
    // Bare `lmstudio` picks the first listed id, which may not be the model the
    // user believes is running; blaming "the model at <endpoint>" sends them
    // after the wrong problem.
    const err = Object.assign(new Error('400 does not support tools'), { status: 400 });
    const provider = new LMStudioProvider({
      client: fakeClient({ models: ['first-model', 'second-model'], throws: err }),
    });
    await expect(provider.chat(messages, tools)).rejects.toThrow(/"first-model"/);
    await expect(provider.chat(messages, tools)).rejects.toThrow(/lmstudio:<model-id>/);
  });

  it('re-throws other errors untouched so the retry layer still sees the status', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const provider = new LMStudioProvider({ model: 'x', client: fakeClient({ throws: err }) });
    await expect(provider.chat(messages, tools)).rejects.toBe(err);
    expect(isRateLimit(err)).toBe(true);
  });
});

describe('LMStudioProvider — discovery on a multi-model server', () => {
  it('says which model it picked and how to pin it', async () => {
    // /v1/models reports what a server can serve, not what is loaded. Picking
    // silently would let the board be designed by a model the user did not choose.
    const lines: string[] = [];
    const provider = new LMStudioProvider({
      client: fakeClient({ models: ['alpha', 'beta', 'gamma'] }),
    });
    expect(await provider.resolvedModelId?.((l) => lines.push(l))).toBe('alpha');
    const note = lines.join('\n');
    expect(note).toContain('listed 3 models');
    expect(note).toContain('"alpha"');
    expect(note).toContain('lmstudio:<model-id>');
    expect(note).toContain('2 others');
  });

  it('stays silent when the server offers exactly one model', async () => {
    const lines: string[] = [];
    const provider = new LMStudioProvider({ client: fakeClient({ models: ['only-one'] }) });
    expect(await provider.resolvedModelId?.((l) => lines.push(l))).toBe('only-one');
    expect(lines).toEqual([]);
  });

  it('stays silent when the id was pinned explicitly', async () => {
    const lines: string[] = [];
    const provider = new LMStudioProvider({ model: 'pinned', client: fakeClient({ models: ['a', 'b'] }) });
    expect(await provider.resolvedModelId?.((l) => lines.push(l))).toBe('pinned');
    expect(lines).toEqual([]);
  });
});

describe('LMStudioProvider — tool calls', () => {
  it('maps native tool calls onto Turn.toolCalls', async () => {
    const provider = new LMStudioProvider({
      model: 'x',
      client: fakeClient({ toolCalls: [nativeCall('read_file', { path: 'docs/SPEC.md' })] }),
    });
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', args: { path: 'docs/SPEC.md' } },
    ]);
    expect(turn.nudge).toBeUndefined();
    expect(turn.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });

  it('advertises the turn tool catalog to the server', async () => {
    const sent: ChatRequestLike[] = [];
    const provider = new LMStudioProvider({
      model: 'x',
      client: fakeClient({ text: 'ok', onRequest: (b) => sent.push(b) }),
    });
    await provider.chat(messages, [tools[0]!]);
    expect(sent[0]?.tools?.map((t) => t.function.name)).toEqual(['read_file']);
  });

  it('nudges when a tool call is written as prose instead of emitted natively', async () => {
    const provider = new LMStudioProvider({
      model: 'x',
      client: fakeClient({
        text: 'I will read it:\n```json\n{"tool": "read_file", "args": {"path": "a.md"}}\n```',
      }),
    });
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toEqual([]);
    expect(turn.nudge).toMatch(/read_file/);
    expect(turn.nudge).toMatch(/as text instead of/);
  });

  it('nudges on the OpenAI-shaped "name" spelling too', async () => {
    const provider = new LMStudioProvider({
      model: 'x',
      client: fakeClient({ text: '{"name": "finish", "arguments": {}}' }),
    });
    expect((await provider.chat(messages, tools)).nudge).toMatch(/finish/);
  });

  it('does not nudge on genuine prose, or on a tool name outside the catalog', async () => {
    const prose = new LMStudioProvider({
      model: 'x',
      client: fakeClient({ text: 'The board already has a pullup on that net.' }),
    });
    const proseTurn = await prose.chat(messages, tools);
    expect(proseTurn.nudge).toBeUndefined();
    expect(proseTurn.text).toBe('The board already has a pullup on that net.');

    // A hallucinated/locked name must not produce a misleading steer.
    const bogus = new LMStudioProvider({
      model: 'x',
      client: fakeClient({ text: '{"tool": "write_file", "args": {}}' }),
    });
    expect((await bogus.chat(messages, [tools[0]!])).nudge).toBeUndefined();
  });

  it('does not nudge when the turn advertised no tools', async () => {
    const provider = new LMStudioProvider({
      model: 'x',
      client: fakeClient({ text: '{"tool": "read_file", "args": {}}' }),
    });
    expect((await provider.chat(messages, [])).nudge).toBeUndefined();
  });
});

describe('OpenAIProvider — regression after the options refactor', () => {
  it('still requires OPENAI_API_KEY', () => {
    expect(() => new OpenAIProvider({})).toThrow(/OPENAI_API_KEY is not set/);
  });

  it('defaults to gpt-5 and honors an explicit model id', async () => {
    const sent: ChatRequestLike[] = [];
    const client = fakeClient({ text: 'ok', onRequest: (b) => sent.push(b) });
    await new OpenAIProvider({ apiKey: 'sk-test', client }).chat(messages, tools);
    await new OpenAIProvider({ apiKey: 'sk-test', model: 'o3', client }).chat(messages, tools);
    expect(sent.map((b) => b.model)).toEqual(['gpt-5', 'o3']);
  });

  it('maps the conversation and preserves vendor-specific tool-call fields', async () => {
    const sent: ChatRequestLike[] = [];
    const history: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'calling',
        toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a' }, extra: { thought: 'sig' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'file body' },
    ];
    const client = fakeClient({ text: 'done', onRequest: (b) => sent.push(b) });
    await new OpenAIProvider({ apiKey: 'sk-test', client }).chat(history, tools);
    const body = sent[0]!;
    expect(body.messages).toHaveLength(4);
    const assistant = body.messages[2] as { tool_calls: Array<Record<string, unknown>> };
    expect(assistant.tool_calls[0]).toMatchObject({ id: 'c1', thought: 'sig' });
    const toolMsg = body.messages[3] as { role: string; tool_call_id: string };
    expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { OpenAIProvider, serializeToolCall, parseToolCall } from '../src/agent/providers/openai.js';
import type { Msg, ToolSchema } from '../src/agent/types.js';

/**
 * The OpenAI provider talks to a real SDK, so the thing worth pinning is the
 * wire contract, not the SDK's own types: which path it posts to, what the
 * request body looks like, and how a response maps onto a Turn. A stub server
 * checks all three without a network call or a key, so an SDK major bump that
 * changes the shape fails here instead of on someone's first paid run.
 */

const tools: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

type Seen = { path: string; auth?: string; body: Record<string, any> };

async function withStubApi(
  reply: unknown,
  run: (provider: OpenAIProvider) => Promise<void>,
): Promise<Seen> {
  let seen: Seen | null = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen = { path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const previous = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    await run(new OpenAIProvider({ model: 'gpt-5', apiKey: 'sk-test' }));
  } finally {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (!seen) throw new Error('the provider never called the API');
  return seen;
}

function completion(message: Record<string, unknown>) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-5',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

describe('OpenAIProvider — wire contract', () => {
  afterEach(() => {
    delete process.env.OPENAI_BASE_URL;
  });

  it('refuses to construct without a key rather than failing mid-run', () => {
    expect(() => new OpenAIProvider({ model: 'gpt-5', apiKey: undefined })).toThrow('OPENAI_API_KEY is not set');
  });

  it('posts chat completions with the key, model, token cap, roles, and tools', async () => {
    const messages: Msg[] = [
      { role: 'system', content: 'You are copperhead.' },
      { role: 'user', content: 'inspect docs/SPEC.md' },
    ];
    const seen = await withStubApi(completion({ role: 'assistant', content: 'ok' }), async (p) => {
      const turn = await p.chat(messages, tools, { maxTokens: 4096 });
      expect(turn.text).toBe('ok');
      expect(turn.toolCalls).toEqual([]);
      expect(turn.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    });

    expect(seen.path).toBe('/v1/chat/completions');
    expect(seen.auth).toBe('Bearer sk-test');
    expect(seen.body.model).toBe('gpt-5');
    // Reasoning models reject max_tokens; the provider must send the newer field.
    expect(seen.body.max_completion_tokens).toBe(4096);
    expect(seen.body.max_tokens).toBeUndefined();
    expect(seen.body.messages.map((m: Msg) => m.role)).toEqual(['system', 'user']);
    expect(seen.body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: tools[0].parameters },
      },
    ]);
  });

  it('omits tools entirely when the tool list is empty (spec gating)', async () => {
    const seen = await withStubApi(completion({ role: 'assistant', content: 'ok' }), async (p) => {
      await p.chat([{ role: 'user', content: 'hi' }], []);
    });
    expect(seen.body.tools).toBeUndefined();
    expect(seen.body.max_completion_tokens).toBe(8192);
  });

  it('round-trips vendor tool-call fields in both directions', async () => {
    const withSignature = completion({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.kicad_sch"}' },
          thought_signature: 'sig-xyz',
        },
      ],
    });

    const seen = await withStubApi(withSignature, async (p) => {
      const turn = await p.chat(
        [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'c0', name: 'x', args: { a: 1 }, extra: { thought_signature: 'sig-prev' } }],
          },
          { role: 'tool', toolCallId: 'c0', content: 'ok' },
        ],
        tools,
      );
      // Parsed out of the response: args decoded, unknown fields kept in extra.
      expect(turn.text).toBeNull();
      expect(turn.toolCalls).toEqual([
        {
          id: 'call_1',
          name: 'read_file',
          args: { path: 'a.kicad_sch' },
          extra: { thought_signature: 'sig-xyz' },
        },
      ]);
    });

    // Sent back up on the next turn: dropping this 400s reasoning backends.
    const assistant = seen.body.messages[1];
    expect(assistant.tool_calls[0].thought_signature).toBe('sig-prev');
    expect(assistant.tool_calls[0].function).toEqual({ name: 'x', arguments: '{"a":1}' });
    expect(seen.body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c0', content: 'ok' });
  });

  it('survives a response with no choices and no usage', async () => {
    await withStubApi({ id: 'x', object: 'chat.completion', created: 1, model: 'gpt-5', choices: [] }, async (p) => {
      const turn = await p.chat([{ role: 'user', content: 'hi' }], []);
      expect(turn).toEqual({ text: null, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } });
    });
  });
});

describe('OpenAIProvider — tool-call codecs', () => {
  it('keeps malformed arguments as _raw instead of throwing', () => {
    expect(parseToolCall({ id: 'c1', type: 'function', function: { name: 'f', arguments: '{not json' } })).toEqual({
      id: 'c1',
      name: 'f',
      args: { _raw: '{not json' },
    });
  });

  it('emits no extra key when a tool call carries only the standard fields', () => {
    const call = parseToolCall({ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } });
    expect('extra' in call).toBe(false);
    expect(serializeToolCall(call)).toEqual({
      id: 'c1',
      type: 'function',
      function: { name: 'f', arguments: '{}' },
    });
  });
});

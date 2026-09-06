import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { AnthropicProvider } from '../src/agent/providers/anthropic.js';
import type { Msg, ToolSchema } from '../src/agent/types.js';

/**
 * What is worth pinning here is the prompt-cache breakpoint layout, not the
 * SDK's types. History capping rewrites arbitrarily old messages, and a rewrite
 * invalidates every cached prefix that covers it, so the loop reports the lowest
 * index it changed and this provider keeps a breakpoint *below* that index (D7).
 * That placement is the whole mitigation: if it silently regressed, the Anthropic
 * path would quietly go back to re-billing the full conversation on every turn a
 * trim first fires, and nothing else in the suite would notice.
 *
 * A stub server captures the real request body, so an SDK change that alters the
 * wire shape fails here rather than on someone's first paid run.
 */

const tools: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

const reply = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 2 },
};

type Body = {
  system?: { cache_control?: unknown }[];
  tools?: { cache_control?: unknown }[];
  messages: { role: string; content: { type: string; cache_control?: unknown }[] }[];
};

const servers: http.Server[] = [];
const prevBase = process.env.ANTHROPIC_BASE_URL;

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = prevBase;
});

/** Run one chat against a stub endpoint and hand back the request body it sent. */
async function capture(messages: Msg[], stablePrefixBefore?: number): Promise<Body> {
  let raw = '';
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      raw = buf;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  const provider = new AnthropicProvider('claude-sonnet-5', 'test-key');
  await provider.chat(messages, tools, stablePrefixBefore === undefined ? {} : { stablePrefixBefore });
  return JSON.parse(raw) as Body;
}

/** Every cache_control breakpoint in the request, across all three regions. */
function breakpoints(body: Body): number {
  const inSystem = (body.system ?? []).filter((b) => b.cache_control).length;
  const inTools = (body.tools ?? []).filter((t) => t.cache_control).length;
  const inConv = body.messages.flatMap((m) => m.content).filter((b) => b.cache_control).length;
  return inSystem + inTools + inConv;
}

const convo: Msg[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'first' },
  { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.md' } }] },
  { role: 'tool', toolCallId: 'c1', content: 'file body' },
  { role: 'user', content: 'second' },
];

describe('AnthropicProvider prompt-cache breakpoints', () => {
  it('places three breakpoints when nothing was rewritten', async () => {
    const body = await capture(convo);
    expect(body.system?.[0]?.cache_control).toBeTruthy();
    expect(body.tools?.[body.tools.length - 1]?.cache_control).toBeTruthy();
    const lastMsg = body.messages[body.messages.length - 1]!;
    expect(lastMsg.content[lastMsg.content.length - 1]!.cache_control).toBeTruthy();
    expect(breakpoints(body)).toBe(3);
  });

  it('adds a fourth breakpoint on the last block below the rewritten index', async () => {
    // Message 3 (the tool result) was rewritten, so everything at index < 3 is
    // still byte-identical to last turn and must stay cacheable.
    const body = await capture(convo, 3);
    expect(breakpoints(body)).toBe(4);

    // The conversation drops the system message, so index 3 (tool result) is
    // conv message 1's first block; the stable end is the assistant tool_use.
    const assistant = body.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content[assistant.content.length - 1]!.cache_control).toBeTruthy();
    expect(assistant.content[assistant.content.length - 1]!.type).toBe('tool_use');
  });

  it('never exceeds the Anthropic maximum of four breakpoints', async () => {
    for (const idx of [0, 1, 2, 3, 4, 5, 99]) {
      const body = await capture(convo, idx);
      expect(breakpoints(body), `stablePrefixBefore=${idx}`).toBeLessThanOrEqual(4);
    }
  });

  it('adds no fourth breakpoint when only system messages sit below the index', async () => {
    // Index 1 leaves just the system message below it, and system messages are
    // filtered out of the conversation, so there is no block to mark.
    const body = await capture(convo, 1);
    expect(breakpoints(body)).toBe(3);
  });

  it('is a no-op when the stable end coincides with the final block', async () => {
    // An index past the end makes the stable end the last block, which already
    // carries a breakpoint: marking it twice must not add one.
    const body = await capture(convo, convo.length);
    expect(breakpoints(body)).toBe(3);
  });
});

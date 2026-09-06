import type { ChatOpts, Msg, ToolSchema, Turn } from '../types.js';

/**
 * The Anthropic Messages-API request shape, shared by the first-party API
 * provider (anthropic.ts) and the Vertex AI provider (vertex.ts). Both clients
 * expose the same `messages.create` surface; everything that defines how a
 * copperhead conversation maps onto it lives here exactly once, so a change to
 * breakpoint placement or block mapping lands on both routes at the same time
 * (design D4). The providers own only client construction and their `name`.
 */

/**
 * The default Claude model id, shared by the `claude` and `vertex` routes so
 * the two cannot drift (design D2): Vertex serves the Claude family under the
 * same ids as the first-party API, so the same default is correct on both.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

type CacheControl = { cache_control?: { type: 'ephemeral' } };
type AnthropicContent = (
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
) &
  CacheControl;

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
  messages: { role: 'user' | 'assistant'; content: AnthropicContent[] }[];
  tools?: unknown[];
}

/** The response subset both clients return from `messages.create`. */
export interface AnthropicResponse {
  content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: string })[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/** The client surface both providers hand to sendAnthropic. */
export interface AnthropicLikeClient {
  messages: { create(params: never): Promise<unknown> };
}

/**
 * The loop resends the full conversation every turn, which is quadratic in
 * input tokens. Three ephemeral cache_control breakpoints (system prompt,
 * last tool definition, last block of the final message) cache the stable
 * prefix plus the conversation up to the previous turn, cutting repeated
 * input cost by roughly an order of magnitude on multi-turn runs.
 */
export function buildAnthropicRequest(model: string, messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): AnthropicRequest {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const conv: { role: 'user' | 'assistant'; content: AnthropicContent[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      conv.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (m.role === 'assistant') {
      const content: AnthropicContent[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const t of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args });
      }
      if (content.length) conv.push({ role: 'assistant', content });
    } else {
      // tool results are user-role content blocks in the Anthropic API
      const prev = conv[conv.length - 1];
      const block: AnthropicContent = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      if (prev && prev.role === 'user') {
        prev.content.push(block);
      } else {
        conv.push({ role: 'user', content: [block] });
      }
    }
  }

  const lastMsg = conv[conv.length - 1];
  const lastBlock = lastMsg?.content[lastMsg.content.length - 1];
  if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };

  const toolDefs = tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as never,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));

  return {
    model,
    max_tokens: opts.maxTokens ?? 8192,
    ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
    messages: conv,
    ...(tools.length ? { tools: toolDefs } : {}),
  };
}

export function parseAnthropicResponse(res: AnthropicResponse): Turn {
  let text: string | null = null;
  const toolCalls = [];
  for (const block of res.content) {
    if (block.type === 'text') text = (text ?? '') + (block as { text: string }).text;
    if (block.type === 'tool_use') {
      const b = block as { id: string; name: string; input: unknown };
      toolCalls.push({ id: b.id, name: b.name, args: b.input as Record<string, unknown> });
    }
  }
  // input_tokens excludes cached tokens; sum them so the run summary stays
  // honest about volume (the discount shows up on the bill, not here).
  const usage = res.usage;
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
    },
  };
}

/** Build, send on the given client, and parse — the whole shared turn. */
export async function sendAnthropic(
  client: AnthropicLikeClient,
  model: string,
  messages: Msg[],
  tools: ToolSchema[],
  opts: ChatOpts = {},
): Promise<Turn> {
  const req = buildAnthropicRequest(model, messages, tools, opts);
  const res = (await client.messages.create(req as never)) as AnthropicResponse;
  return parseAnthropicResponse(res);
}

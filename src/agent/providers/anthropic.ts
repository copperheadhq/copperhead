import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from '../types.js';

type CacheControl = { cache_control?: { type: 'ephemeral' } };
type AnthropicContent = (
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
) &
  CacheControl;

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private readonly inFlight = new Set<AbortController>();

  constructor(
    private readonly model = 'claude-sonnet-5',
    private readonly apiKey = process.env.ANTHROPIC_API_KEY,
  ) {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  }

  /**
   * The loop resends the full conversation every turn, which is quadratic in
   * input tokens. Three ephemeral cache_control breakpoints (system prompt,
   * last tool definition, last block of the final message) cache the stable
   * prefix plus the conversation up to the previous turn, cutting repeated
   * input cost by roughly an order of magnitude on multi-turn runs.
   */
  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const aborter = new AbortController();
    this.inFlight.add(aborter);
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: this.apiKey, maxRetries: 0 });

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

      const res = await client.messages.create({
        model: this.model,
        max_tokens: opts.maxTokens ?? 8192,
        ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
        messages: conv as never,
        ...(tools.length ? { tools: toolDefs as never } : {}),
      }, { signal: aborter.signal });

      let text: string | null = null;
      const toolCalls = [];
      for (const block of res.content) {
        if (block.type === 'text') text = (text ?? '') + block.text;
        if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, args: block.input as Record<string, unknown> });
        }
      }
      // input_tokens excludes cached tokens; sum them so the run summary stays
      // honest about volume (the discount shows up on the bill, not here).
      const usage = res.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
      return {
        text,
        toolCalls,
        usage: {
          inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        },
      };
    } finally {
      this.inFlight.delete(aborter);
    }
  }

  async close(): Promise<void> {
    for (const aborter of this.inFlight) aborter.abort();
    this.inFlight.clear();
  }
}

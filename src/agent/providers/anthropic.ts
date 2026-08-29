import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from '../types.js';
import { DEFAULT_CLAUDE_MODEL, sendAnthropic } from './anthropic-wire.js';

/**
 * First-party Anthropic API provider. Owns only client construction and its
 * name; the request/response shape (cache breakpoints, block mapping, token
 * accounting) is shared with the Vertex provider via anthropic-wire.ts (D4).
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';

  constructor(
    private readonly model = DEFAULT_CLAUDE_MODEL,
    private readonly apiKey = process.env.ANTHROPIC_API_KEY,
  ) {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    return sendAnthropic(client, this.model, messages, tools, opts);
  }
}

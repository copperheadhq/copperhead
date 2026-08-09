import { DEFAULT_API_KEY_ENV, isLocalEndpoint } from '../../config.js';
import type OpenAI from 'openai';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn, ToolCall } from '../types.js';

/** Pointing the provider at an OpenAI-compatible endpoint (design D1). */
export interface OpenAIProviderOptions {
  /** Endpoint base URL; omitted means the client's own default (OpenAI). */
  baseURL?: string | undefined;
  /** Name of the env var holding the key. Never the key itself. */
  apiKeyEnv?: string | undefined;
}

export class OpenAIProvider implements Provider {
  readonly name: string;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;
  private client: OpenAI | null = null;

  constructor(
    private readonly model = 'gpt-5',
    opts: OpenAIProviderOptions = {},
    env: NodeJS.ProcessEnv = process.env,
  ) {
    // Credentials are always resolved through a named env var, never accepted
    // as a literal value: the one way to supply a key keeps application code
    // from ever holding one directly (mirrors AC-4.1 elsewhere). Tests inject
    // fake values through the `env` argument, not through opts.
    const keyEnv = opts.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    this.baseURL = opts.baseURL;
    // A compat endpoint must be structurally ineligible for the paid
    // OpenAI/Anthropic failover in otherProvider() (loop.ts) — it is not
    // OpenAI, and a rate limit there must never silently redirect a run the
    // user deliberately pointed elsewhere to someone else's paid API.
    this.name = this.baseURL ? 'openai-compat' : 'openai';
    this.apiKey = env[keyEnv];
    // A loopback endpoint (Ollama) serves the same API with no credential, and
    // it is the one backend that is both free and fully local — requiring a
    // dummy key there would be a papercut on the most useful config (D4).
    if (!this.apiKey && !isLocalEndpoint(this.baseURL)) {
      throw new Error(`${keyEnv} is not set`);
    }
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const client = await this.getClient();
    const res = await client.chat.completions.create({
      model: this.model,
      max_completion_tokens: opts.maxTokens ?? 8192,
      messages: messages.map((m) => {
        switch (m.role) {
          case 'system':
            return { role: 'system' as const, content: m.content };
          case 'user':
            return { role: 'user' as const, content: m.content };
          case 'assistant':
            return {
              role: 'assistant' as const,
              content: m.content,
              ...(m.toolCalls?.length
                ? {
                    tool_calls: m.toolCalls.map(serializeToolCall),
                  }
                : {}),
            };
          case 'tool':
            return { role: 'tool' as const, tool_call_id: m.toolCallId, content: m.content };
        }
      }),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    });
    const choice = res.choices[0];
    // Capture any non-standard properties returned by the API (e.g. Gemini thought
    // signatures) so they can be echoed back on subsequent turns. Dropping them
    // causes reasoning-model backends to reject the follow-up request with 400.
    const toolCalls = ((choice?.message.tool_calls ?? []) as unknown as Record<string, unknown>[]).map(parseToolCall);
    return {
      text: choice?.message.content ?? null,
      toolCalls,
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
    };
  }

  private async getClient(): Promise<OpenAI> {
    if (!this.client) {
      const { default: OpenAICtor } = await import('openai');
      this.client = new OpenAICtor({
        // A local endpoint may legitimately have no key, but the client still
        // wants a non-empty string, so send a placeholder it will never check.
        apiKey: this.apiKey ?? 'no-key-required',
        ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      });
    }
    return this.client;
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { _raw: s };
  }
}

export function serializeToolCall(t: ToolCall) {
  return {
    id: t.id,
    type: 'function' as const,
    function: { name: t.name, arguments: JSON.stringify(t.args) },
    // Preserve vendor-specific tool-call fields (e.g. Gemini thought signatures).
    // Dropping them makes the next turn's request 400.
    ...(t.extra || {}),
  };
}

export function parseToolCall(t: Record<string, unknown>): ToolCall {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (k !== 'id' && k !== 'type' && k !== 'function') {
      extra[k] = v;
    }
  }
  const fn = t.function as { name: string; arguments: string };
  return {
    id: t.id as string,
    name: fn.name,
    args: safeParse(fn.arguments),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

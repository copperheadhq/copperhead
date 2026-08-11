import { DEFAULT_API_KEY_ENV, isLocalEndpoint } from '../../config.js';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn, ToolCall } from '../types.js';

/** The slice of an OpenAI-compatible chat completion this provider reads. */
export interface ChatCompletionLike {
  choices: Array<{ message: { content?: string | null; tool_calls?: unknown[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** The request body this provider sends. Named so the fields stay compile-checked
 *  even though the client itself is only structurally typed. */
export interface ChatRequestLike {
  model: string;
  max_completion_tokens: number;
  messages: unknown[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: unknown };
  }>;
}

/**
 * Structural subset of the `openai` SDK client we depend on. Declared locally so
 * tests can inject a fake and run with no network — the same seam
 * `CodexProviderOptions.client` gives the Codex path.
 */
export interface ChatClientLike {
  chat: { completions: { create(body: ChatRequestLike): Promise<ChatCompletionLike> } };
  models: { list(): Promise<{ data: Array<{ id: string }> }> };
}

export interface OpenAIProviderOptions {
  /** Model id. Defaults to `gpt-5` for this provider. */
  model?: string;
  /** Defaults to `OPENAI_API_KEY`. Must be non-empty. */
  apiKey?: string;
  /** Named environment variable from which a compatible endpoint reads its key. */
  apiKeyEnv?: string;
  /** Override the API host. Omitted for the real OpenAI API; set by subclasses
   *  that talk to an OpenAI-compatible server (see `lmstudio.ts`). */
  baseURL?: string;
  /** Production leaves this unset and the SDK client is built lazily; tests
   *  inject a fake so no network call is made. */
  client?: ChatClientLike;
}

export class OpenAIProvider implements Provider {
  // Widened to `string` so a subclass can narrow it to its own provider name.
  // The name is load-bearing: `otherProvider` in loop.ts only fails over between
  // 'openai' and 'anthropic', so any other name is structurally no-fallback.
  readonly name: string;

  protected readonly model: string | undefined;
  protected readonly apiKey: string | undefined;
  protected readonly baseURL: string | undefined;
  private readonly injectedClient: ChatClientLike | undefined;
  /** Memoized so a run builds one client instead of one per turn. */
  private clientPromise: Promise<ChatClientLike> | undefined;

  constructor(
    modelOrOpts: string | OpenAIProviderOptions = {},
    positionalOpts: OpenAIProviderOptions = {},
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const opts = typeof modelOrOpts === 'string' ? { ...positionalOpts, model: modelOrOpts } : modelOrOpts;
    this.model = opts.model;
    const keyEnv = opts.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    this.apiKey = opts.apiKey ?? env[keyEnv];
    this.baseURL = opts.baseURL;
    this.injectedClient = opts.client;
    this.name = this.baseURL ? 'openai-compat' : 'openai';
    // Subclasses that authenticate differently satisfy this by passing their own
    // non-empty placeholder (the SDK requires a string), never a cloud key.
    if (!this.apiKey && !isLocalEndpoint(this.baseURL)) throw new Error(`${keyEnv} is not set`);
  }

  protected async client(): Promise<ChatClientLike> {
    if (this.injectedClient) return this.injectedClient;
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { default: OpenAI } = await import('openai');
        return new OpenAI({
          apiKey: this.apiKey ?? 'no-key-required',
          ...(this.baseURL ? { baseURL: this.baseURL } : {}),
        }) as unknown as ChatClientLike;
      })();
    }
    return this.clientPromise;
  }

  /** The model id to send. Overridable so a backend that hosts whatever model
   *  the user has loaded can discover it at call time (see `lmstudio.ts`). */
  protected async resolveModelId(_client: ChatClientLike): Promise<string> {
    return this.model ?? 'gpt-5';
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const client = await this.client();
    const res = await client.chat.completions.create({
      model: await this.resolveModelId(client),
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

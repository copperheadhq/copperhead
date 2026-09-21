import { DEFAULT_API_KEY_ENV, isLocalEndpoint } from '../../config.js';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn, ToolCall } from '../types.js';
// The undici *runtime* package ships its own Agent types, but the dispatcher
// slot on fetch's RequestInit is typed by undici-types (bundled with
// @types/node); they are structurally compatible but nominally distinct.
import type { Dispatcher } from 'undici-types';

/** Pointing the provider at an OpenAI-compatible endpoint (design D1). */
export interface OpenAIProviderOptions {
  /** Endpoint base URL; omitted means the client's own default (OpenAI). */
  baseURL?: string | undefined;
  /** Name of the env var holding the key. Never the key itself. */
  apiKeyEnv?: string | undefined;
  /** Per-request HTTP timeout in ms. Compat endpoints (local inference) can
   * legitimately take longer than the OpenAI SDK's 10-minute default on a
   * single turn — a large generation on a CPU-served model is measured in tens
   * of minutes — so baseURL runs default to 60 minutes; the agent loop's turn
   * watchdog remains the real upper bound either way. */
  requestTimeoutMs?: number | undefined;
}

export class OpenAIProvider implements Provider {
  readonly name: string;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;
  private readonly requestTimeoutMs: number | undefined;

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
    this.requestTimeoutMs = opts.requestTimeoutMs ?? (this.baseURL ? 60 * 60_000 : undefined);
    // A loopback endpoint (Ollama) serves the same API with no credential, and
    // it is the one backend that is both free and fully local — requiring a
    // dummy key there would be a papercut on the most useful config (D4).
    if (!this.apiKey && !isLocalEndpoint(this.baseURL)) {
      throw new Error(`${keyEnv} is not set`);
    }
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      // A local endpoint may legitimately have no key, but the client still
      // wants a non-empty string, so send a placeholder it will never check.
      apiKey: this.apiKey ?? 'no-key-required',
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      ...(this.requestTimeoutMs !== undefined ? { timeout: this.requestTimeoutMs } : {}),
      // Compat/local servers can spend long stretches inside one streamed
      // response producing reasoning tokens the wire never sees. Undici's
      // default bodyTimeout (300s of silence) aborts those healthy requests
      // — observed live as "Request timed out" mid-turn — so give compat
      // requests a dispatcher with no socket-level body deadline; the SDK's
      // `timeout` option above is still the real bound.
      ...(this.baseURL
        ? {
            fetchOptions: {
              dispatcher: new (await import('undici')).Agent({
                bodyTimeout: 0,
                headersTimeout: 0,
              }) as unknown as Dispatcher,
            },
          }
        : {}),
    });
    const params = {
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
              // compat backends (Ollama chatml) 400 on a null content; an
              // empty string means the same thing and is legal everywhere.
              content: m.content ?? '',
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
    };
    if (this.baseURL) {
      // Compat/local endpoints can spend many silent minutes inside one
      // non-streaming request — long enough for intermediate HTTP timeouts
      // (undici's 5-minute headersTimeout, proxies) to abort a healthy turn.
      // Streaming returns headers immediately and every delta is progress, so
      // slow local generation only has to keep producing tokens.
      return this.chatStream(client, params, opts);
    }
    const res = await client.chat.completions.create(params);
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

  /** Mid-stream socket drops ("terminated", ECONNRESET, ...) surface inside
   * the iteration, past the SDK's create()-level retry — re-issue the request
   * instead. The request is idempotent and compat backends prefix-cache the
   * prompt, so a retry only re-pays generation. API errors (4xx bodies with
   * reasons) are deterministic and are never retried. */
  private async chatStream(
    client: InstanceType<typeof import('openai').default>,
    params: Record<string, unknown>,
    opts: ChatOpts,
  ): Promise<Turn> {
    let lastErr: unknown;
    for (let issue = 0; ; issue++) {
      try {
        return await this.consumeStream(client, params, opts);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const status = (err as { status?: number }).status;
        // 5xx on a compat backend is usually the server failing to parse the
        // MODEL's own tool-call output ("error parsing tool call") — stochastic
        // generation, so the identical request samples clean on retry.
        const transient =
          (typeof status === 'number' && status >= 500) ||
          /terminated|fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket|premature|other side closed|stream error|timed? ?out/i.test(
            msg,
          );
        if (!transient || issue >= 2) throw err;
      }
    }
  }

  /** SSE accumulate: content deltas join into text, tool-call deltas are merged
   * by `index` (id/name land once, arguments stream as string fragments). */
  private async consumeStream(
    client: InstanceType<typeof import('openai').default>,
    params: Record<string, unknown>,
    opts: ChatOpts,
  ): Promise<Turn> {
    const stream = (await client.chat.completions.create({
      ...params,
      stream: true,
      stream_options: { include_usage: true },
    } as never)) as unknown as AsyncIterable<{
      usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null;
      choices?: Array<{
        delta?: { content?: string | null; tool_calls?: Array<Record<string, unknown>> } | null;
      }>;
    }>;
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const deltas = new Map<number, { id: string; name: string; arguments: string; extra: Record<string, unknown> }>();
    let streamedChars = 0;
    for await (const chunk of stream) {
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string') text += delta.content;
      for (const tc of delta.tool_calls ?? []) {
        const idx = (tc.index as number) ?? deltas.size;
        const acc = deltas.get(idx) ?? { id: '', name: '', arguments: '', extra: {} };
        if (typeof tc.id === 'string') acc.id = tc.id;
        const fn = tc.function as { name?: string; arguments?: string } | undefined;
        if (fn?.name) acc.name += fn.name;
        if (fn?.arguments) acc.arguments += fn.arguments;
        for (const [k, v] of Object.entries(tc)) {
          if (k !== 'index' && k !== 'id' && k !== 'type' && k !== 'function') acc.extra[k] = v;
        }
        deltas.set(idx, acc);
      }
      const now = text.length + [...deltas.values()].reduce((a, d) => a + d.arguments.length, 0);
      if (now !== streamedChars) {
        streamedChars = now;
        opts.onStream?.(streamedChars);
      }
    }
    const toolCalls: ToolCall[] = [...deltas.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, d]) => ({ id: d.id, name: d.name, args: safeParse(d.arguments), ...(Object.keys(d.extra).length ? { extra: d.extra } : {}) }));
    return {
      text: text || null,
      toolCalls,
      usage: { inputTokens, outputTokens },
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

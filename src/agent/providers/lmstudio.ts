import { OpenAIProvider } from './openai.js';
import type { ChatClientLike, OpenAIProviderOptions } from './openai.js';
import type { ChatOpts, Msg, ToolSchema, Turn } from '../types.js';

/**
 * Local-model provider: points the OpenAI-compatible client at an LM Studio
 * server instead of `api.openai.com`, so copperhead runs against a model on the
 * user's own machine with NO cloud API key — for privacy-sensitive designs,
 * offline/air-gapped work, and zero marginal cost. See the `add-lmstudio-provider`
 * change (D1–D6).
 *
 * LM Studio speaks the OpenAI chat-completions protocol, including OpenAI-style
 * function calling, so this reuses `OpenAIProvider`'s message and tool-call
 * mapping wholesale (D1) and only supplies the endpoint, the placeholder
 * credential, model discovery, and local-server diagnostics.
 *
 * The same base-URL seam generalizes to any other OpenAI-compatible local server
 * (Ollama, vLLM, llama.cpp) via `LMSTUDIO_BASE_URL`.
 *
 * Two properties are load-bearing:
 *
 *  - **No cloud key.** The API key sent is a literal placeholder, never
 *    `OPENAI_API_KEY` (D2). LM Studio ignores it; the SDK only requires a
 *    non-empty string. A local run must not carry a cloud credential to whatever
 *    host `LMSTUDIO_BASE_URL` names.
 *  - **No silent fallback to a billed provider.** The distinct `name` makes
 *    `otherProvider` in loop.ts return null for us, exactly as for codex and
 *    claude-code.
 */

export const LMSTUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1';

/**
 * Placeholder credential. LM Studio does not authenticate; the `openai` SDK
 * throws on an empty key. Deliberately a literal and NOT `process.env.*` (D2).
 */
const PLACEHOLDER_API_KEY = 'lm-studio';

export type LMStudioProviderOptions = Omit<OpenAIProviderOptions, 'apiKey'>;

/**
 * Pick the endpoint, treating blank/whitespace-only as unset.
 *
 * Load-bearing, not tidiness: `??` alone preserves `''`, and the base class omits
 * a falsy `baseURL` from the SDK options, so an empty `LMSTUDIO_BASE_URL` would
 * silently fall through to the SDK default — `https://api.openai.com` — sending a
 * run the user asked to keep local to a cloud host. `.env.example` ships the key
 * present-but-empty, which is exactly how that happens in practice.
 */
function resolveBaseURL(explicit?: string): string {
  return explicit?.trim() || process.env.LMSTUDIO_BASE_URL?.trim() || LMSTUDIO_DEFAULT_BASE_URL;
}

export class LMStudioProvider extends OpenAIProvider {
  override readonly name = 'lmstudio';
  /** Memoized result of the model-discovery probe (D3). */
  private discovered: string | undefined;

  constructor(opts: LMStudioProviderOptions = {}) {
    super({
      ...opts,
      baseURL: resolveBaseURL(opts.baseURL),
      apiKey: PLACEHOLDER_API_KEY,
    });
  }

  /** The base URL actually in use, for error messages and tests. */
  get endpoint(): string {
    return this.baseURL ?? LMSTUDIO_DEFAULT_BASE_URL;
  }

  cacheKeyEndpoint(): string {
    return this.endpoint;
  }

  needsModelDiscovery(): boolean {
    return !this.model;
  }

  /**
   * Public entry point for discovery, so `loop.ts` can learn the real model id
   * before it builds the response cache and the run metadata — those are
   * constructed up front, and would otherwise record the routing string
   * `lmstudio` and let two different local models share cache entries (F6).
   */
  async resolvedModelId(log?: (line: string) => void): Promise<string> {
    return this.resolveModelId(await this.client(), log);
  }

  /**
   * `lmstudio:<id>` names the model outright. Bare `lmstudio` asks the server
   * which model is loaded (D3) and memoizes the answer for the run.
   *
   * `/v1/models` reports what a server can serve, not what it has loaded, and no
   * field distinguishing the two is portable across LM Studio, Ollama, and vLLM.
   * So the first entry is a pick, not a lookup: on Ollama it is one of every
   * pulled model, and on LM Studio with JIT loading one of every downloaded one.
   * Guessing silently is the real hazard — the board would be designed by a model
   * the user did not choose — so when the server offers a choice we say which one
   * we took and how to pin it, rather than pretending it was determined.
   */
  protected override async resolveModelId(
    client: ChatClientLike,
    log?: (line: string) => void,
  ): Promise<string> {
    if (this.model) return this.model;
    if (this.discovered) return this.discovered;
    const listed = await client.models.list();
    const id = listed.data[0]?.id;
    if (!id) {
      throw new Error(
        `LM Studio is running at ${this.endpoint} but no model is loaded — load one from the ` +
          'Developer tab (or `lms load <model>`), or name it explicitly with --model lmstudio:<model-id>',
      );
    }
    if (listed.data.length > 1) {
      const others = listed.data.length - 1;
      log?.(
        `${this.endpoint} listed ${listed.data.length} models; using "${id}". ` +
          `A server that lists more than the loaded model (Ollama, or LM Studio with JIT loading) ` +
          `may not have this one running — pin it with --model lmstudio:<model-id> ` +
          `(${others} other${others === 1 ? '' : 's'} available).`,
      );
    }
    this.discovered = id;
    return id;
  }

  override async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    let turn: Turn;
    try {
      turn = await super.chat(messages, tools, opts);
    } catch (err) {
      throw this.explain(err);
    }
    // Local models vary in function-calling reliability. When one replies with
    // tool-call-shaped prose instead of a native tool call, the loop would
    // otherwise just stall with no hint that the MODEL is the problem. Steer it
    // via the existing nudge seam (D4) — same role as claude-code's
    // detectMalformedCall, but for the native-vs-text confusion.
    if (!turn.toolCalls.length && tools.length && turn.text) {
      const nudge = detectTextToolCall(turn.text, new Set(tools.map((t) => t.name)));
      if (nudge) return { ...turn, nudge };
    }
    return turn;
  }

  /**
   * Turn the diagnosable local-server failures into actionable errors. Anything
   * else is re-thrown UNTOUCHED so its `status` survives for
   * `isRateLimit`/`withRetry` — the same status-first discipline as
   * claude-code's `isAuthError`.
   */
  private explain(err: unknown): unknown {
    if (isConnectionError(err)) {
      return new Error(
        `no LM Studio server reachable at ${this.endpoint} — start it (LM Studio ▸ Developer ▸ ` +
          'Start Server, or `lms server start`), or point LMSTUDIO_BASE_URL at the right host. ' +
          `copperhead never falls back to a cloud provider for a local run (original error: ${
            (err as Error)?.message ?? String(err)
          })`,
        { cause: err },
      );
    }
    if (isToolsUnsupported(err)) {
      // Name the model, not just the endpoint. Bare `lmstudio` picks the first
      // listed id, which on a multi-model server may not be the one the user
      // believes is running; blaming "the model at <endpoint>" then sends them
      // after the wrong problem. Naming it makes the claim checkable.
      const which = this.model ?? this.discovered;
      const subject = which ? `the model "${which}" at ${this.endpoint}` : `the model at ${this.endpoint}`;
      return new Error(
        `${subject} rejected the tool-calling request — copperhead needs a tool-capable model ` +
          '(one whose card advertises function/tool calling), since every action it takes is a ' +
          `tool call. If that is not the model you expected, pin it with --model lmstudio:<model-id> ` +
          `(original error: ${(err as Error)?.message ?? String(err)})`,
        { cause: err },
      );
    }
    return err;
  }
}

/** A connection failure to the local server, as surfaced by the `openai` SDK
 *  (`APIConnectionError`, whose `cause` is the undici/Node error) or by a raw
 *  fetch in a test fake. Never a live HTTP status. */
function isConnectionError(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (typeof status === 'number') return false; // the server answered; not a connection problem
  const codes = [err, (err as { cause?: unknown })?.cause]
    .map((e) => (e as { code?: string })?.code)
    .filter(Boolean);
  if (codes.some((c) => c === 'ECONNREFUSED' || c === 'ENOTFOUND' || c === 'ECONNRESET' || c === 'EHOSTUNREACH')) {
    return true;
  }
  const name = (err as Error)?.name ?? '';
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  return /connection error|econnrefused|failed to fetch|fetch failed|socket hang up/.test(msg);
}

/** A 400 from the local server complaining about the tools/functions parameter:
 *  the loaded model has no function-calling support. */
function isToolsUnsupported(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (status !== 400) return false;
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  return /tool|function[_ ]?call/.test(msg);
}

/**
 * Detect a tool call the model wrote as prose instead of emitting natively. The
 * signature is a JSON-ish object naming a tool in THIS turn's catalog — the same
 * catalog check claude-code's parser uses, so a hallucinated name does not
 * trigger a misleading steer. Returns a one-line nudge, or undefined when the
 * absence of a call is genuine (plain prose, no tool named).
 */
function detectTextToolCall(text: string, catalog: Set<string>): string | undefined {
  // Matches both the OpenAI shape ("name": "read_file") and the generic one
  // ("tool": "read_file") that instruction-tuned local models tend to invent.
  const re = /"(?:tool|name|function|tool_name)"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const named = m[1]!;
    if (catalog.has(named)) {
      return (
        `You wrote a call to "${named}" as text instead of emitting a tool call. copperhead only ` +
        'dispatches native tool calls, so nothing ran. Re-emit it using the tool-calling API. If ' +
        'this keeps happening, the model loaded in LM Studio may not support function calling — ' +
        'load a tool-capable model.'
      );
    }
  }
  return undefined;
}

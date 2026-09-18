import { mkdtemp, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from '../types.js';
import { parseToolCalls, renderConversation, renderDelta, renderToolProtocol } from './tool-protocol.js';

/**
 * Saved-login provider: drives Claude Code through the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`) and reuses its saved login (the
 * `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or a logged-in CLI), so a
 * Claude subscription user runs copperhead with no ANTHROPIC_API_KEY. What is
 * reused is the login, not necessarily a separately-installed `claude` binary:
 * the SDK ships its own. See the `add-claude-code-provider` change (D1–D6).
 *
 * It is a REASONING-ONLY backend. The Agent SDK is built to run its own
 * autonomous multi-turn tool loop, which conflicts with copperhead's contract
 * that `loop.ts` is the single driver and every mutation flows through the
 * capability-filtered tools, obligations ledger, ERC/DRC gates, snapshot, and
 * commit gate. So each `chat()` issues exactly ONE `query()` with no SDK tools
 * registered and built-ins disabled, in an isolated cwd — the SDK executes
 * nothing. copperhead's tools are advertised to the model as a text protocol;
 * the model replies with a JSON tool-call block that we parse back into
 * `Turn.toolCalls`. The spec-gated-in invariant stays structural: we advertise
 * exactly the tools `availableTools(ctx)` returned for the turn.
 *
 * Auth stays external (D2): the constructor performs no API-key check and the
 * provider never reads, copies, or logs the credential — the SDK resolves
 * CLAUDE_CODE_OAUTH_TOKEN / the logged-in CLI itself.
 */

/** Structural subset of the Agent SDK's `query` surface we depend on. Declared
 * locally rather than `import type`d from the SDK on purpose: the SDK is an
 * undeclared optional dependency (design D3), so importing its types would force
 * it to be installed for `tsc` to pass — the exact coupling `codex.ts` now has.
 * Naming the options here still compile-checks our option keys (e.g. `tools`),
 * which is the safety the review asked for without the packaging cost. */
export type DenyResult = { behavior: 'deny'; message: string; interrupt?: boolean };
export type AllowResult = { behavior: 'allow'; updatedInput?: Record<string, unknown> };
export type CanUseToolLike = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<DenyResult | AllowResult>;

export interface QueryOptions {
  systemPrompt?: string;
  model?: string;
  /** `[]` disables all built-in tools (Agent SDK 0.3.x). */
  tools?: string[];
  disallowedTools?: string[];
  /** Called before any tool executes; we deny everything (reasoning-only). */
  canUseTool?: CanUseToolLike;
  cwd?: string;
  env?: Record<string, string | undefined>;
  maxTurns?: number;
  /** Aborting this controller stops the query and tears down the `claude`
   * subprocess it spawned (Agent SDK `Options.abortController`). Used so the
   * watchdog's `close()` on a hung turn kills the process instead of orphaning
   * it (2.2/4.1) — a stranded subprocess keeps writing to its temp cwd and, with
   * KiCad local history, was a source of the disk-fill halt (I8). */
  abortController?: AbortController;
  /** Resume a prior SDK session by id so the subprocess reconstructs earlier
   * turns itself instead of us re-sending the whole conversation each turn (1.1,
   * `Options.resume`). Only set in the opt-in session-resume mode. */
  resume?: string;
  /** Emit `stream_event` messages as the model generates, on top of the
   * complete `assistant` message (Agent SDK `Options.includePartialMessages`).
   * Used only as a progress signal for the turn watchdog and heartbeat; the
   * reply is still read from the complete message. */
  includePartialMessages?: boolean;
}
export interface QueryArgs {
  prompt: string;
  options?: QueryOptions;
}
export interface QueryMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type: string; text?: string }> };
  usage?: { input_tokens?: number; output_tokens?: number };
  /** On a `stream_event` message: the raw Messages-API stream event. */
  event?: { type: string; delta?: { type: string; text?: string } };
}
export type QueryLike = (args: QueryArgs) => AsyncIterable<QueryMessage>;

/** Injectable dynamic import of the optional SDK. Exists so the
 * missing-dependency path stays testable now that the SDK is a declared
 * optional dependency (installed in a normal/CI install). The default keeps the
 * specifier non-literal so tsc never resolves the optional dep at build time. */
export type ImportLike = (specifier: string) => Promise<unknown>;

/** Explicit deny list, belt-and-suspenders on top of the empty `tools` allowlist.
 * `'*'` is the documented wildcard; the named entries stay for clarity and in
 * case a given SDK build does not honor the wildcard. */
const DISALLOWED_BUILTINS = [
  '*',
  'Bash',
  'Edit',
  'MultiEdit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
];

export class ClaudeCodeProvider implements Provider {
  readonly name = 'claude-code';
  private callSeq = 0;
  private cwdPromise?: Promise<string>;
  /** In-flight query aborters, so close() (called by the turn watchdog on a
   * hung turn) can tear down the live subprocess, not just delete its cwd. */
  private readonly inFlight = new Set<AbortController>();
  /** Session-resume state (1.1). `sessionId` is the last session the SDK reported;
   * `sentCount` is how many `messages` we have already handed it, so a resumed
   * turn sends only the delta. Unused unless `sessionResume` is on. */
  private sessionId?: string;
  private sentCount = 0;

  constructor(
    private readonly model?: string,
    private readonly injectedQuery?: QueryLike,
    private readonly importSdk: ImportLike = (specifier) => import(specifier),
    /**
     * Opt-in: resume one SDK session across turns and send only new messages,
     * instead of flattening and re-sending the entire conversation every turn
     * (1.1). Cuts the ~quadratic history re-send that dominates long-stage cost.
     * OFF by default and deliberately mutually exclusive with the response cache:
     * the cache replays turns the resumed session never saw, so mixing them would
     * desync the session. `makeProvider` enables it only when the cache is off.
     */
    private readonly sessionResume = false,
  ) {}

  // `opts.maxTokens` is intentionally ignored: the Agent SDK drives the Claude
  // Code subprocess and exposes no per-call max-tokens knob. `opts.onStream` is
  // honored: this provider streams, so it reports cumulative streamed-text length
  // as blocks arrive, which the loop turns into a liveness heartbeat (5.1).
  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const query = await this.resolveQuery();

    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const systemPrompt = [system, renderToolProtocol(tools)].filter(Boolean).join('\n\n');
    // Session-resume mode (1.1): once the SDK has given us a session id, resume it
    // and send only the messages added since our last turn — the subprocess still
    // holds the earlier conversation, so re-sending it would just re-bill it. The
    // first turn (no session id yet) sends the full flattened history as usual.
    const resume = this.sessionResume ? this.sessionId : undefined;
    const prompt = resume ? renderDelta(messages, this.sentCount) : renderConversation(messages);
    const catalog = new Set(tools.map((t) => t.name));
    const cwd = await this.ensureCwd();

    let text: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    // Visible text streamed so far, for the heartbeat's count (see stream_event).
    let streamedChars = 0;
    // One aborter per turn: close() aborts it to kill a hung subprocess.
    const aborter = new AbortController();
    this.inFlight.add(aborter);
    try {
      for await (const msg of query({
        prompt,
        options: {
          systemPrompt,
          ...(this.model ? { model: this.model } : {}),
          abortController: aborter,
          // Partial-message events are the turn's progress signal: without them
          // the SDK yields nothing until the reply is complete, so a turn that is
          // still generating looks exactly like a hung one to the watchdog.
          includePartialMessages: true,
          // Layered "the SDK executes nothing" defense (D1/D5):
          //  1. `tools: []` disables ALL built-in tools (Agent SDK 0.3.x docs:
          //     "[] (empty array) - Disable all built-in tools").
          //  2. `disallowedTools` denies by name, with a wildcard, as a backstop.
          //  3. `canUseTool` denies every tool BEFORE it runs — the permission
          //     analog to Codex's read-only sandbox — so even an unrecognized
          //     future tool cannot execute.
          //  4. The tool_use tripwire below fails the run loudly if one is
          //     emitted anyway. Any single layer failing is caught by the next.
          tools: [],
          ...(resume ? { resume } : {}),
          disallowedTools: DISALLOWED_BUILTINS,
          canUseTool: async (toolName) => ({
            behavior: 'deny',
            message: `copperhead claude-code is reasoning-only; the SDK must not execute tools (blocked ${toolName}).`,
            interrupt: true,
          }),
          cwd,
          // The SDK's `env` REPLACES the subprocess environment entirely, so
          // inherit process.env and strip the billed API keys: a claude-code run
          // must use the saved login and never silently a paid ANTHROPIC_API_KEY
          // / OPENAI_API_KEY, even when one is also set (D2).
          env: { ...process.env, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined },
          maxTurns: 1,
        },
      })) {
        if (msg.type === 'stream_event') {
          // Every partial event is progress (thinking and block boundaries too),
          // and reporting it restarts the loop's inactivity watchdog; only text
          // deltas grow the count. The reply itself is still read from the
          // complete `assistant` message below, never reassembled from deltas.
          const delta = msg.event?.delta;
          if (delta?.type === 'text_delta' && delta.text) streamedChars += delta.text.length;
          opts.onStream?.(streamedChars);
        } else if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              text = (text ?? '') + block.text;
              // Report progress so the loop's heartbeat shows this turn is alive
              // and streaming, not hung, during a multi-minute large-output turn.
              opts.onStream?.(text.length);
            } else if (block.type === 'tool_use') {
              // Load-bearing invariant (D1): the SDK must execute nothing, so it
              // must never emit a tool_use block. If it does, `tools: []` was not
              // honored — fail loudly rather than let an edit bypass copperhead's
              // snapshot / verify / commit gates.
              throw new Error(
                'claude-code: the Agent SDK emitted a tool_use block, but its tools are ' +
                  'disabled — the reasoning-only invariant was violated (SDK option drift?). ' +
                  'Refusing to continue.',
              );
            }
          }
        } else if (msg.type === 'result') {
          if (typeof msg.usage?.input_tokens === 'number') inputTokens = msg.usage.input_tokens;
          if (typeof msg.usage?.output_tokens === 'number') outputTokens = msg.usage.output_tokens;
        }
        // The session id can arrive on any message (init/system/result); keep the
        // latest so the next turn can resume it (1.1). No-op unless resume is on.
        if (this.sessionResume && typeof msg.session_id === 'string') this.sessionId = msg.session_id;
      }
    } catch (err) {
      // Auth failures get an actionable message (non-retryable); everything else
      // — crucially a 429 — is re-thrown untouched so its status survives for
      // withRetry/isRateLimit (D4). We never fall back to a keyed provider: the
      // distinct `name` makes otherProvider() return null for us.
      if (isAuthError(err)) throw new Error(authHint((err as Error).message));
      throw err;
    } finally {
      this.inFlight.delete(aborter);
    }

    // Only advance the high-water mark on a turn that completed: a thrown turn
    // (rate limit, timeout) is retried, and must re-send the same delta so no
    // message is lost from the resumed session (1.1).
    if (this.sessionResume) this.sentCount = messages.length;

    const parsed = parseToolCalls(text, () => `cc-${++this.callSeq}`, catalog);
    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      withheld: parsed.withheld,
      usage: { inputTokens, outputTokens },
      nudge: parsed.nudge,
    };
  }

  /** Tear down in-flight work and remove the scratch cwd. Called by the turn
   * watchdog on a hung turn (via withTimeout's onTimeout) AND once per run in a
   * finally. Aborting first kills the `claude` subprocess a hung turn spawned —
   * without it the process is orphaned and keeps writing to its temp cwd, which
   * (with KiCad local history) was a source of the disk-fill halt (2.2/4.1, I8).
   * A leftover empty dir in the OS tmpdir is harmless; the startup sweep reclaims
   * any that a hard SIGKILL bypassed this cleanup for. */
  async close(): Promise<void> {
    for (const aborter of this.inFlight) {
      try {
        aborter.abort();
      } catch {
        // best effort: a controller that already settled throws nothing useful
      }
    }
    this.inFlight.clear();
    const pending = this.cwdPromise;
    this.cwdPromise = undefined;
    if (!pending) return;
    try {
      await rm(await pending, { recursive: true, force: true });
    } catch {
      // best effort: a leftover empty dir in the OS tmpdir is harmless
    }
  }

  /** One isolated scratch cwd per provider instance, created once and reused
   * across turns so a long run does not leak a temp dir per turn. Even with
   * tools disabled this guarantees the SDK has no path into the repo (D5). */
  private async ensureCwd(): Promise<string> {
    if (!this.cwdPromise) this.cwdPromise = mkdtemp(path.join(os.tmpdir(), 'copperhead-cc-'));
    const cwd = await this.cwdPromise;
    // Keep this reused scratch dir's mtime fresh on every turn. It is the only
    // long-lived temp dir a run holds (kicad-cli dirs are per-call), so a
    // multi-hour run would otherwise leave it with a stale mtime and a concurrent
    // run's startup sweep (sweepStaleTempDirs, age-gated) could delete it out from
    // under the live process (F4). Best-effort: a touch failure is harmless.
    const now = new Date();
    await utimes(cwd, now, now).catch(() => {});
    return cwd;
  }

  private async resolveQuery(): Promise<QueryLike> {
    if (this.injectedQuery) return this.injectedQuery;
    let mod: { query?: QueryLike; default?: { query?: QueryLike } };
    try {
      // importSdk defaults to a non-literal `import()`, so tsc never resolves the
      // optional dependency at build time and it may legitimately be absent (D3).
      mod = (await this.importSdk('@anthropic-ai/claude-agent-sdk')) as {
        query?: QueryLike;
        default?: { query?: QueryLike };
      };
    } catch (err) {
      // Only a genuinely-absent module gets the "install it" message; a present
      // but broken install surfaces its real error rather than being mislabeled.
      const code = (err as { code?: string }).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'the claude-code provider needs the optional dependency @anthropic-ai/claude-agent-sdk; ' +
            'install it with `npm i @anthropic-ai/claude-agent-sdk`',
        );
      }
      throw err;
    }
    const query = mod.query ?? mod.default?.query;
    if (!query) {
      throw new Error(
        '@anthropic-ai/claude-agent-sdk did not export `query`; the installed version may be incompatible',
      );
    }
    return query;
  }
}

function isAuthError(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  // A present status is authoritative: only 401/403 are auth failures, so a 429
  // (or anything else) is NOT treated as auth and is re-thrown untouched — its
  // status must survive for withRetry/isRateLimit even if the message mentions
  // "oauth token". Only when there is no status do we fall back to a narrow
  // message heuristic.
  if (typeof status === 'number') return status === 401 || status === 403;
  const m = ((err as Error)?.message ?? '').toLowerCase();
  return /unauthenticat|unauthoriz|not logged in|please log in|invalid api key|oauth token|setup-token/.test(m);
}

function authHint(detail: string): string {
  return (
    'claude-code is not authenticated: log in to Claude Code, or run `claude setup-token` and ' +
    `set CLAUDE_CODE_OAUTH_TOKEN. copperhead never reads your credential itself (original error: ${detail})`
  );
}

# Design — add-claude-code-provider

## Context

Every LLM run passes through `runAgentLoop` (`src/agent/loop.ts`), which owns the agent loop and, critically, all of copperhead's safety orchestration: the git snapshot taken before edits, ERC/DRC verification after a mutation, the repair loop bounded by `maxRepairCycles`, rollback to a byte-identical tree on persistent failure, the commit gate that refuses while any obligation is open, and the structural spec-gating that hides edit tools until a proposal validates. Providers are deliberately thin: a provider implements only `chat(messages, tools) -> Turn` (`src/agent/types.ts`), one model call per turn; the loop recomputes `availableTools(ctx)` every turn and dispatches the returned tool calls itself (`src/agent/loop.ts` turn loop, `dispatchTool` in `src/agent/tools.ts`).

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is built to be an autonomous agent: its `query()` runs its own multi-turn loop and executes tools internally, and it does not read the interactive CLI login automatically — it resolves auth from environment credentials, notably `CLAUDE_CODE_OAUTH_TOKEN` (minted by `claude setup-token`). Fitting that SDK behind copperhead's thin, single-turn, loop-driven `Provider` seam is the whole design problem.

Constraints inherited from SPEC.md: the two structural invariants (spec-gated-in edit tools; verification-gated-out mutations) must hold for every provider; rate-limit handling is exponential backoff ×3 then fail over to the *other keyed* provider (§4.5); `check` is untouched (it never enters the loop).

## Goals / Non-Goals

**Goals:**

- Run copperhead against a Claude subscription with **no `ANTHROPIC_API_KEY`**, billed through the user's Claude Code login.
- Reuse the existing `Provider` seam and `loop.ts` orchestration unchanged, so `claude-code` inherits every safety gate identically to `gpt-5`/`claude`.
- Keep authentication entirely external — copperhead never reads, copies, or logs the credential.
- Ship the SDK as an optional dependency that non-users never install or load.

**Non-Goals:**

- Native SDK tool execution / letting the SDK drive the agent loop (see D1's rejected alternative).
- A saved-login provider for any other host agent (Codex, etc.) — out of scope for this change.
- Automating `claude setup-token` or managing the token's lifecycle — the CLI owns that.
- Any change to `check`, `init`, or the existing providers' behavior.

## Decisions

### D1 — Reasoning-only backend behind the single-turn `Provider` seam (the core decision)

`ClaudeCodeProvider.chat()` issues **one** `query()` per copperhead turn with **no SDK tools registered and the built-in tools disabled** (`tools: []` plus a `disallowedTools` belt-and-suspenders), so the SDK runs a single model call and executes nothing. copperhead's `availableTools(ctx)` schemas are advertised to the model as a text protocol in the system prompt; the model replies with a fenced `json` object `{ "tool": <name>, "args": {…} }`, which `chat()` parses into `Turn.toolCalls`. `loop.ts` then dispatches through `dispatchTool` and enforces every gate exactly as for the other providers.

The spec-gated-in invariant stays **structural**: the advertised tool set is `availableTools(ctx)` recomputed each turn, so a tool that is locked (edit tools before the proposal validates) is simply not in the prompt, and `dispatchTool` re-checks regardless.

**Rejected alternative — register copperhead's tools as native in-process SDK tools and let `query()` drive the loop.** The SDK would then execute copperhead's tools and run the whole agentic loop itself. This bypasses `loop.ts`, so copperhead's snapshot / verify / repair / rollback / commit-gate / obligations orchestration — which lives *around* the tool calls in `loop.ts`, not inside the tool handlers — would have to be re-implemented for this one provider. In a tool whose entire value proposition is verified, reversible edits, forking the safety path per-provider is unacceptable. The reasoning-only mapping keeps a single, well-tested safety path for all providers.

**Trade-off:** the model expresses tool calls as prompt-protocol JSON rather than the native tool-calling APIs the OpenAI/Anthropic providers use, which is less structurally reliable. Mitigations: the protocol is explicit and single-shape; malformed JSON is tolerated (treated as assistant text, mirroring `safeParse` in `openai.ts`) so a stray reply degrades to a nudge rather than a crash; and the loop's existing stall/nudge handling absorbs an occasional non-conforming turn.

**Verifying "the SDK executes nothing".** The whole safety story rests on the SDK not running any tool, so it is defended in four layers, each caught by the next if it fails:

1. `tools: []` disables all built-ins. This is the documented mechanism: `@anthropic-ai/claude-agent-sdk@0.3.x` `Options.tools` is `string[] | { type:'preset'; preset:'claude_code' }` and its doc states *"`[]` (empty array) - Disable all built-in tools"* (confirmed against the pinned version).
2. `disallowedTools` denies by name, led by the `'*'` wildcard, as a backstop the enumerated list cannot outrun as new tools ship.
3. `canUseTool` denies **every** tool before it executes (with `interrupt: true`). This is the Agent-SDK analog to `CodexProvider`'s read-only sandbox / `approvalPolicy: 'never'`: even a tool the other layers do not name cannot run.
4. A **runtime tripwire**: if any streamed assistant message still contains a `tool_use` block, `chat()` throws immediately, turning a silent "the SDK started executing tools" regression into a loud, run-failing error.

The option *names* are compile-checked against a local `QueryOptions` interface (the SDK is an undeclared optional dep per D3, so `import type` from it would force it to be installed for `tsc`, the coupling `codex.ts` now carries; a local interface catches a typo in `tools`/`disallowedTools` without that cost). A parsed tool call is also only accepted when its name is in the turn's advertised catalog (`availableTools(ctx)`), so a hallucinated or locked name is left as prose for the loop to nudge rather than dispatched.

### D2 — Authentication stays entirely external

The provider does no credential handling: no env-var reads for secrets, and — unlike `OpenAIProvider`/`AnthropicProvider` — **no API-key check in the constructor**. The SDK resolves `CLAUDE_CODE_OAUTH_TOKEN` (or a logged-in CLI) by its own precedence. A missing or unauthenticated install surfaces as an SDK error that `chat()` turns into an actionable message ("log in to Claude Code / run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`") and lets propagate through the loop's normal failure/rollback path. That auth-vs-not decision is made **status-first**: an error carrying an HTTP status is auth only on 401/403, so a 429 (or anything else) is re-thrown untouched and stays retryable even if its message happens to mention "oauth token"; the message heuristic applies only when there is no status.

The SDK's precedence would also accept a plain `ANTHROPIC_API_KEY` if one is set, which would silently **bill the API key instead of the subscription** — cutting against the no-fallback promise (D4). To prevent that, `chat()` passes the SDK's `env` option with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` stripped (the SDK's `env` *replaces* the subprocess environment, so the rest of `process.env` is spread through). A `claude-code` run therefore always uses the saved login. Rationale: the "saved login" promise is precisely that the CLI, not copperhead, owns auth; touching the credential would break it and the AC-4.1 no-secrets guarantee.

### D3 — Declared `optionalDependency`, lazily imported

The provider `await import()`s `@anthropic-ai/claude-agent-sdk` (non-literal specifier) inside `chat()` wrapped in try/catch; a module-resolution failure becomes an actionable, non-retryable error ("install the optional dependency `@anthropic-ai/claude-agent-sdk`"). The SDK is loaded only when `--model claude-code` is selected, so startup cost for other providers is unchanged. No `zod` is needed in the provider because no SDK tools are registered.

The SDK is listed under `optionalDependencies`, so a normal `npm install` includes it and an install run with `--omit=optional` still works (the lazy import then surfaces the actionable error). Declaring it was blocked until the SDK's peers were satisfiable: `@anthropic-ai/claude-agent-sdk@0.3.x` hard-**peers** on `@anthropic-ai/sdk >=0.93.0` (also `zod ^4`, `@modelcontextprotocol/sdk ^1.29`), which conflicted with copperhead's previously-pinned `@anthropic-ai/sdk ^0.39.0` (`optionalDependencies` does not shield against a *peer* conflict: npm's ERESOLVE fails the whole install). The prerequisite change (PR #56) bumped copperhead's `@anthropic-ai/sdk` to `^0.113.0` and added an `overrides` entry pinning `zod` to `^4.0.0` (copperhead imports `zod` nowhere, and openai's `zod ^3` peer is optional and unused), which satisfies all three peers and lets `npm install` resolve without `--legacy-peer-deps`. *Rejected alternative:* keeping the SDK an undeclared manual install to avoid touching the core `@anthropic-ai/sdk` pin, which left the happy path uninstallable-by-default and untestable in CI.

### D4 — Distinct provider name ⇒ no silent fallback to a paid API

The provider's `name` is `'claude-code'`, distinct from `'openai'`/`'anthropic'`. The rate-limit failover `otherProvider(current)` (`src/agent/loop.ts:57`) only swaps `openai↔anthropic` when the *other* key exists, so it returns `null` for a `claude-code` current provider automatically — a rate-limited `claude-code` run never silently continues on a separately-billed API. To keep the retry/failover machinery working, `chat()` **re-throws the original SDK error** (preserving `status`/`statusCode`) so `withRetry`/`isRateLimit` still see a 429 and back off; it only wraps the missing-dependency and unauthenticated cases (which are non-retryable) into friendlier messages.

### D5 — Isolated working directory, cleaned up on `close()`

`query()` is given `cwd` = a `mkdtemp` scratch directory. Even with tools disabled this guarantees the SDK has no path into the repo, reinforcing that every real mutation flows only through copperhead's own tools under `loop.ts`. One dir is created per provider instance and reused across the run's turns (not one per `chat()`), and the provider implements `Provider.close()` to `rm` it. `loop.ts` calls `provider.close?.()` on every provider in a `finally`, so the scratch dir does not outlive the run (matching `CodexProvider`'s `ownsWorkingDirectory` cleanup).

### D6 — Injectable `queryFn` seam for offline tests

The constructor is `(model?: string, queryFn?: QueryLike)`. `queryFn` defaults to the lazy SDK import but can be injected, so offline tests script SDK responses (assistant text, tool-call JSON, usage, thrown `{status:429}`) with no network, no SDK install, and no login. This mirrors the loop-level `opts.provider` seam but at the provider granularity the change's offline tests need, and matches the injectable-client requirement.

## Risks / Trade-offs

- [Prompt-protocol tool calls are less reliable than native tool calling] → single explicit JSON shape; malformed output tolerated as text; the loop's stall/nudge path absorbs occasional misses (D1).
- [A future SDK version changes `query()` options or message shapes] → the SDK is isolated behind this one provider and the injectable `queryFn`; a breaking change touches one file and its offline tests.
- [Per-turn `query()` spawns the CLI/session each turn] → correctness-first; full history is re-sent each turn exactly as the other providers already do. A persistent `ClaudeSDKClient` session is a possible later optimization, not required for parity.
- [User confusion between `claude-<id>` (Anthropic API) and `claude-code[:id]` (saved login)] → routing order and docs make the distinction explicit; the colon form for model ids avoids collision with the `claude-` hyphen prefix.
- [Unauthenticated/missing-install failures look like generic errors] → `chat()` maps those two cases to actionable messages while preserving retryable statuses for everything else (D2, D4).

## Open Questions

- None blocking. A persistent-session optimization and a matching saved-login Codex provider are explicitly out of scope (Non-Goals).

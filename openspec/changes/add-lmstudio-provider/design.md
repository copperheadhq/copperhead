# Design — add-lmstudio-provider

## Context

Every LLM run passes through `runAgentLoop` (`src/agent/loop.ts`), which owns the agent loop and all of copperhead's safety orchestration: the git snapshot taken before edits, ERC/DRC verification after a mutation, the repair loop bounded by `maxRepairCycles`, rollback to a byte-identical tree on persistent failure, the commit gate that refuses while any obligation is open, and the structural spec-gating that hides edit tools until a proposal validates. Providers are deliberately thin: a provider implements only `chat(messages, tools) -> Turn` (`src/agent/types.ts`), one model call per turn; the loop recomputes `availableTools(ctx)` every turn and dispatches the returned tool calls itself.

Unlike the `codex` and `claude-code` changes, the hard part here is **not** fitting a foreign agent runtime behind that seam. LM Studio speaks the OpenAI chat-completions protocol, tool calling included, so the existing `OpenAIProvider` mapping is already the right code — it is just wired shut. `OpenAIProvider` throws when `OPENAI_API_KEY` is unset (`openai.ts:10`), constructs `new OpenAI({ apiKey })` with no host override (`openai.ts:15`), and `makeProvider` has no local branch. The design problem is therefore about **factoring and safety properties**, not protocol translation: how to open that seam without weakening the guarantees that keep a local run local.

Constraints inherited from SPEC.md: the two structural invariants (spec-gated-in edit tools; verification-gated-out mutations) must hold for every provider; rate-limit handling is exponential backoff ×3 then fail over to the *other keyed* provider (§4.5); secrets live in env vars only and are redacted at write time (AC-4.1); `check` is contractually LLM-free and network-free (AC-2.1) and never enters the loop.

## Goals / Non-Goals

**Goals:**

- Run copperhead entirely against a model on the user's own machine, with **no API key of any kind** and no vendor account — for privacy-sensitive designs, offline/air-gapped work, and zero marginal cost.
- Reuse the existing OpenAI chat/tool-call mapping rather than duplicating it, and reuse `loop.ts` orchestration unchanged so `lmstudio` inherits every safety gate identically to `gpt-5`.
- Make "a local run never becomes a billed run" a structural property, not a convention.
- Keep the endpoint configurable through env/config and never committed.
- Fail actionably on the failure modes that are specific to a local server, since the user is now the operator of their own backend.

**Non-Goals:**

- Managing the LM Studio install, server lifecycle, or model downloads — the user owns those.
- Auto-detecting a local server in the model-resolution fallback chain (see D5).
- A text-protocol tool-call fallback for models without native function calling (see D4's rejected alternative).
- Dedicated providers for Ollama / vLLM / llama.cpp — the base-URL override already reaches them.
- Any change to `check`, `init`, or the existing providers' behavior.

## Decisions

### D1 — Subclass `OpenAIProvider` behind an options-object constructor (the core decision)

`OpenAIProvider`'s constructor becomes `OpenAIProviderOptions { model?, apiKey?, baseURL?, client? }`, matching the `CodexProviderOptions` idiom already in the repo. `LMStudioProvider extends OpenAIProvider` and supplies only what differs: the endpoint, the placeholder credential, model discovery, diagnostics, and the nudge. The chat mapping, `serializeToolCall`/`parseToolCall`, and the Gemini `extra`-field preservation are inherited untouched and stay single-sourced.

This also adds, for the first time on the OpenAI path, an **injectable client seam** (`client?: ChatClientLike`, a locally declared structural subset of the SDK client). Both providers become testable offline; previously `openai.ts` built its client inline inside `chat()` and could not be tested without a network. As a side benefit the client is now memoized per provider instead of reconstructed on every turn.

`name` widens from the literal `'openai'` to `string` so the subclass can narrow it to `'lmstudio'`.

**Rejected alternative — parameterize one class and pass `name` in at the call site.** Fewer files, but `name` is load-bearing: `otherProvider` decides whether a rate-limited run may move to a billed provider purely by comparing it. Making it a constructor argument turns the no-cloud-fallback guarantee into something every construction site must get right, and a future call site that forgets it silently sends a local run's traffic to a paid key. As a subclass field it is a compile-time property of the type.

**Rejected alternative — composition (an `LMStudioProvider` that wraps and delegates to an `OpenAIProvider`).** Equivalent in behavior, but it still requires the same seam work in `openai.ts`, and the two hooks the local path needs (`resolveModelId`, error wrapping around the whole call including discovery) are natural overrides and awkward delegations.

**Trade-off:** `LMStudioProvider` inherits from a class whose name says OpenAI, which reads oddly. Accepted: the shared thing genuinely is the OpenAI *protocol*, and the alternative is duplicating ~50 lines of message mapping that must then be kept in step forever.

### D2 — A literal placeholder credential, never a cloud key

LM Studio does not authenticate, but the `openai` SDK requires a non-empty API key string. The provider sends the literal `'lm-studio'`.

That it is a **literal and not `process.env.OPENAI_API_KEY`** is the security-relevant part. `LMSTUDIO_BASE_URL` is user-configurable and may name any host; forwarding the ambient cloud key would mean a misconfigured or hostile base URL exfiltrates a live credential. The placeholder makes that impossible by construction. `LMStudioProviderOptions` is `Omit<OpenAIProviderOptions, 'apiKey'>`, so no caller can override it either.

This also means the inherited `if (!this.apiKey) throw` check in the base constructor is satisfied naturally by the placeholder — no bypass flag is needed, and the "must have a key" rule stays intact for the OpenAI path.

### D3 — Discover the loaded model once, rather than sending a placeholder id

`/v1/chat/completions` requires a `model` field, but bare `--model lmstudio` names none. On first `chat()`, `resolveModelId` calls `models.list()` and takes the first entry, memoizing it for the run. `lmstudio:<id>` skips the probe entirely.

The reason to spend a request on this is that the model id is not decorative: it goes into `run-start` metadata (AC-8.1) and into the response-cache key (`response-cache.ts`, `modelId`, F6). A placeholder would make two different local models share cache entries and would make run metadata unable to answer "which model produced this board". The probe also produces a precise error — "running, but no model is loaded" — that a placeholder id would surface as an opaque 404.

**Trade-off:** one extra request per run, to localhost, before the first completion. Cheap, and the only network activity added anywhere in the change.

### D4 — Native tool calls only, with a nudge for models that write them as prose

The provider accepts only native OpenAI `tool_calls`. Local models vary in function-calling reliability, and a model that emits a call as prose would otherwise produce a turn with no tool calls — which the loop reads as a stall, giving the user no hint that the *model* is the problem.

So: when a turn advertised tools, dispatched none, and the text contains a JSON-ish object naming a tool **in that turn's catalog**, `chat()` returns `Turn.nudge` (an existing field on `Turn`, already consumed by the loop) telling the model to re-emit it natively and flagging that the loaded model may not be tool-capable. The catalog check mirrors claude-code's `detectMalformedCall`: a hallucinated or locked tool name is left alone rather than producing a misleading steer.

**Rejected alternative — a full text-protocol fallback parser (reuse claude-code's tolerant brace scanner and dispatch prose calls for real).** It would widen the set of usable local models, but it means a second, less reliable tool-call path on a provider whose model quality is already the weak link, and it silently rewards models that cannot do the thing copperhead needs. Diagnosing the problem beats papering over it: the requirement "load a tool-capable model" is stated in the docs, the error text, and the nudge.

### D5 — No localhost auto-detection in `resolveModel`

`resolveModel` keeps its precedence chain (flag > `COPPERHEAD_MODEL` > config > available key) unchanged; `lmstudio` must be selected explicitly. It is not added to the key-fallback tier.

`resolveModel` is synchronous and contractually free of I/O — it runs in `check`'s neighborhood and in every command's startup path. Probing a socket to decide which model to use would make model resolution network-dependent and give startup a variable-latency failure mode. Worse, an implicit fallback to a local model is a silent change of *which model designed the board*, which is exactly the kind of thing run metadata exists to make explicit. Only the doc comment and the no-model error message change.

### D6 — No new dependency; the base-URL seam generalizes

The provider needs nothing that is not already a required dependency: `openai` is used for the existing OpenAI path. This is a deliberate contrast with `codex` (`@openai/codex-sdk`) and `claude-code` (`@anthropic-ai/claude-agent-sdk`), both optional dependencies with lazy imports and missing-install error paths. None of that machinery is needed here, so none of it is added.

Because the only requirement is the OpenAI chat-completions protocol with tool calling, `LMSTUDIO_BASE_URL` also reaches Ollama (`:11434/v1`), vLLM (`:8000/v1`), and llama.cpp. Documented as such, with no separate provider names — a second name would be a second routing branch and a second set of docs for identical code.

### D7 — Actionable errors only for the diagnosable cases; everything else passes through

Three local-server failures get wrapped: unreachable server (naming the endpoint and `LMSTUDIO_BASE_URL`), server with no model loaded, and a 400 naming tools/functions (model is not tool-capable). Every other error is re-thrown **untouched**.

This is the status-first discipline claude-code's `isAuthError` established: a wrapped error loses its `status`, and `withRetry`/`isRateLimit` key off `status === 429`. Connection detection therefore explicitly returns false when a numeric status is present — if the server answered, it is not a connection problem, whatever the message says.

## Risks / Trade-offs

- **Model quality is now the user's variable.** A weak local model will produce worse designs than `gpt-5`/`claude`. This is inherent to the feature; the safety gates (ERC/DRC verification, repair loop, rollback, commit gate) are unchanged and remain the backstop — a bad local model produces a rolled-back run, not a broken board.
- **Tool-calling reliability varies by model.** Mitigated by D4's nudge and by stating the tool-capable requirement in the docs, the setup steps, and the error text.
- **`LMSTUDIO_BASE_URL` can name a remote host.** By design (it is what makes vLLM-on-another-box work), and the reason D2's placeholder credential is a literal. A run to a remote host is still not a *billed* run and still cannot leak a cloud key.
- **The subclass couples the local path to `openai.ts`'s internals.** A future refactor of the OpenAI mapping must keep `resolveModelId` and the protected fields intact. Bounded, and the offline regression tests for `OpenAIProvider` added in this change make a break loud.

## Migration Plan

Additive. No existing model value changes routing, no config migration, no new dependency. The `OpenAIProvider` constructor signature changes from positional to an options object, but it has only two construction sites (both in `loop.ts`) and is not part of the published CLI surface; `test/toolcall-extra.test.ts` imports the free functions, not the class.

## Open Questions

None blocking. Worth revisiting if the feature sees use: whether `lmstudio` should become an alias of a more generally named `local` provider once other local servers are exercised in practice, and whether the discovered model should be surfaced in the CLI's startup header alongside the provider name.

# Add a local-model `lmstudio` provider

## Why

copperhead's model backends are all cloud or hosted-session: OpenAI (`gpt-5`) and Anthropic (`claude`) bill an API key per token, and Codex (`codex`), Claude Code (`claude-code`), and Cursor (`cursor`) reuse a hosted subscription login. Every one of them requires an account with a remote vendor, so there is **no way to run copperhead against a model on the user's own machine** — which rules out privacy-sensitive designs, offline and air-gapped work, and zero-marginal-cost iteration.

LM Studio serves local models behind an OpenAI-compatible HTTP endpoint (default `http://localhost:1234/v1`), including OpenAI-style function/tool calling for capable models. copperhead already speaks that protocol — `src/agent/providers/openai.ts` does the full chat and tool-call mapping via the `openai` SDK. It is simply unreachable today, because `OpenAIProvider` hard-requires `OPENAI_API_KEY` (throws if unset) and exposes no base-URL override, so it always hits `api.openai.com`; and `makeProvider` (`src/agent/loop.ts:75`) has no local route.

This change adds a local provider, selected by `--model lmstudio` (and `lmstudio:<model-id>`), that points the OpenAI-compatible client at a local server and needs **no API key of any kind**. Unlike `codex` and `claude-code` it requires no new dependency: it reuses the already-required `openai` package.

## What Changes

- **`OpenAIProvider` gains an options-object constructor** `{ model?, apiKey?, baseURL?, client? }`, matching the `CodexProviderOptions` idiom. This adds the `baseURL` override the local path needs and — for the first time on the OpenAI path — an **injectable client seam**, so provider tests run offline. The client is now built once and memoized per provider instead of reconstructed on every `chat()`. The message mapping, `serializeToolCall`/`parseToolCall`, and the Gemini `extra`-field preservation are unchanged.
- **New provider** `src/agent/providers/lmstudio.ts` (`name: 'lmstudio'`), a subclass of `OpenAIProvider` that supplies the endpoint (default `http://localhost:1234/v1`, overridable via `LMSTUDIO_BASE_URL`), a placeholder credential, model discovery, and local-server diagnostics. Subclassing keeps the OpenAI-compatible mapping single-sourced and makes the distinct provider name a compile-time property rather than a call-site argument.
- **No cloud key on a local run**: the API key sent is a literal placeholder (`'lm-studio'`), never `process.env.OPENAI_API_KEY`. LM Studio does not authenticate; the SDK only requires a non-empty string. A local run must not carry a cloud credential to whatever host `LMSTUDIO_BASE_URL` names.
- **No silent fallback to a billed provider**: the distinct `name` means `otherProvider` (`src/agent/loop.ts:110`) returns `null` for an `lmstudio` run — a local run can never silently become a billed one, mirroring the `codex`/`claude-code` property. `otherProvider` needs no code change; the guarantee is structural.
- **Model discovery**: `lmstudio:<id>` names the model outright; bare `lmstudio` asks the server which model is loaded (once per run, memoized) so the real model id reaches run metadata and the response-cache key (`modelId`, F6) instead of a placeholder — two different local models must not share cache entries.
- **Actionable local-server errors** for the three diagnosable failures — unreachable server, server with no model loaded, and a loaded model that rejects tool calls. Everything else is re-thrown untouched so `status` survives for `withRetry`/`isRateLimit`.
- **Tool-call nudge**: local models vary in function-calling reliability. When a turn advertised tools, dispatched none, and the prose contains a call naming a tool in the current catalog, the provider returns `Turn.nudge` so the loop steers instead of stalling with no hint that the model is the problem.
- **`check` stays LLM-free and network-free**: the provider is reachable only via `makeProvider` and is never imported from `src/commands/check`; the transitive import scan in `test/init-check.test.ts` already rejects any `providers/` import and covers the new file with no change.
- **Docs + config**: `--model` routing docs (`src/config.ts` comment, `src/cli.ts` help, `.env.example`, the configuration reference, the CLI reference, the quickstart, `README.md`) document `lmstudio` / `lmstudio:<id>`, `LMSTUDIO_BASE_URL`, the no-key setup, the tool-capable-model requirement, and that the same seam reaches Ollama/vLLM/llama.cpp.

## Capabilities

### New Capabilities

- `lmstudio-provider`: a local-model LLM backend selected by `--model lmstudio` / `lmstudio:<id>` that drives an OpenAI-compatible server on the user's own machine, requires no API key or vendor account, keeps the endpoint configurable via env/config and never committed, discovers the loaded model, fails actionably when the local server is unreachable or unusable, maps onto the existing `Provider` seam so all of copperhead's safety gates apply, and never falls back to a billed provider.

### Modified Capabilities

- `cli-surface`: `--model` / `COPPERHEAD_MODEL` / config `model` gain the `lmstudio` and `lmstudio:<id>` values, routed ahead of the catch-all OpenAI route.

## Impact

- `src/agent/providers/openai.ts` — options-object constructor with `baseURL` and an injectable `client`; memoized client; overridable `resolveModelId`; `name` widened to `string` so a subclass can narrow it. No behavior change for existing OpenAI runs.
- `src/agent/providers/lmstudio.ts` — new provider (endpoint default + `LMSTUDIO_BASE_URL`, placeholder credential, one-shot model discovery, connection/no-model/tools-unsupported diagnostics, text-tool-call nudge).
- `src/agent/loop.ts` — `makeProvider` gains an `lmstudio` / `lmstudio:` branch before the OpenAI fallthrough; the two `OpenAIProvider` construction sites move to the options object; `otherProvider`'s comment names the new no-fallback case.
- `src/config.ts` — `resolveModel` doc comment documents the new values, that they need no API key, and that a local server is deliberately never auto-detected (the function is sync and contractually network-free); the no-model error names `--model lmstudio`.
- `src/cli.ts` — `--model` help strings for `do` and `create`.
- `.env.example`, `docs/src/content/docs/reference/configuration.md`, `docs/src/content/docs/reference/cli.md`, `docs/src/content/docs/getting-started/quickstart.mdx`, `README.md` — document `lmstudio`, `LMSTUDIO_BASE_URL`, the tool-capable-model requirement, and the other-local-server generalization.
- `test/lmstudio-provider.test.ts` — new offline suite (routing, endpoint default/override/precedence, no-cloud-key, no-fallback, model discovery and memoization, unreachable/no-model/tools-unsupported errors, 429 passthrough, native tool-call mapping, nudge cases) plus regression coverage for the refactored `OpenAIProvider`, all via an injected fake client with no network and no LM Studio install.
- `test/agent-integration.test.ts` — opt-in live provider-parity entry gated on `COPPERHEAD_TEST_LMSTUDIO=1` (AC-3.10).
- `openspec/specs/SPEC.md` — extend AC-3.10 to include `--model lmstudio`; add AC-3.21 (local model); note the new provider in §2 and §4.4 and the new env var in the `.env.example` reference.
- No new dependency, no changes to `check` (stays LLM-free/network-free), and no breaking changes to existing providers or CLI flags.

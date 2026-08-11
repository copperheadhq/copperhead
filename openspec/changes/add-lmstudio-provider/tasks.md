# Tasks — add-lmstudio-provider

## 1. OpenAI provider seam

- [x] 1.1 Replace `OpenAIProvider`'s positional `(model, apiKey)` constructor with `OpenAIProviderOptions { model?, apiKey?, baseURL?, client? }` (D1), matching the `CodexProviderOptions` idiom; widen `readonly name` to `string` so a subclass can narrow it
- [x] 1.2 Declare a local structural `ChatClientLike` (`chat.completions.create`, `models.list`) plus `ChatRequestLike`/`ChatCompletionLike`, so the request fields stay compile-checked while tests can inject a fake and run offline (D1)
- [x] 1.3 Build the SDK client lazily in a `protected client()` and memoize it per provider instead of constructing one per `chat()` call; forward `baseURL` when set
- [x] 1.4 Extract the model id behind a `protected async resolveModelId(client)` (base: `this.model ?? 'gpt-5'`) so a backend that hosts whatever model the user loaded can discover it at call time (D3)
- [x] 1.5 Leave the message mapping, `serializeToolCall`/`parseToolCall`, and the Gemini `extra`-field preservation untouched; update the two construction sites in `loop.ts`

## 2. Provider implementation

- [x] 2.1 Create `src/agent/providers/lmstudio.ts` with `class LMStudioProvider extends OpenAIProvider` (`name = 'lmstudio'`), exporting `LMSTUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1'` and an `endpoint` getter
- [x] 2.2 Resolve the base URL as `opts.baseURL ?? LMSTUDIO_BASE_URL ?? default`; type options as `Omit<OpenAIProviderOptions, 'apiKey'>` so no caller can inject a credential (D2)
- [x] 2.3 Send a literal placeholder API key (`'lm-studio'`), never `process.env.OPENAI_API_KEY` — the base constructor's non-empty-key check is satisfied naturally, with no bypass flag (D2)
- [x] 2.4 Override `resolveModelId`: pass `lmstudio:<id>` through; for bare `lmstudio` call `models.list()` once, memoize, and error actionably when the list is empty (D3)
- [x] 2.5 Override `chat()` to wrap the call: map connection failures and tool-unsupported 400s to actionable messages naming the endpoint, and re-throw everything else untouched so `status` survives for `withRetry`/`isRateLimit` (D7) — connection detection returns false whenever a numeric status is present
- [x] 2.6 Return `Turn.nudge` when a turn advertised tools, dispatched none, and the text names a tool in that turn's catalog; leave out-of-catalog names alone (D4)

## 3. Routing

- [x] 3.1 In `makeProvider` (`src/agent/loop.ts`), add an `model === 'lmstudio' || model.startsWith('lmstudio:')` branch **before** the catch-all OpenAI return; reject an empty `lmstudio:` override
- [x] 3.2 Confirm `otherProvider` returns `null` for an `lmstudio` current provider (distinct name ⇒ no fallback, no code change needed); extend its comment to name the local case

## 4. Config & docs

- [x] 4.1 Update the `resolveModel` doc comment in `src/config.ts` to document `lmstudio` / `lmstudio:<id>`, that they need no API key, and that a local server is deliberately never auto-detected because the function is sync and network-free (D5); name `--model lmstudio` in the no-model-configured error
- [x] 4.2 Update `.env.example`: add `LMSTUDIO_BASE_URL` with the tool-capable-model requirement and the Ollama/vLLM generalization; add both values to the `COPPERHEAD_MODEL` routing table
- [x] 4.3 Update `src/cli.ts` `--model` help strings for `do` and `create`
- [x] 4.4 Update `docs/src/content/docs/reference/configuration.md`: env-var table, model-selection precedence note, routing table, and a "Local models (LM Studio)" section
- [x] 4.5 Update `docs/src/content/docs/reference/cli.md` and `docs/src/content/docs/getting-started/quickstart.mdx`
- [x] 4.6 Update `README.md`: the requirements bullet, the `--model` line, and a "Local models (LM Studio)" section

## 5. Tests

- [x] 5.1 Create `test/lmstudio-provider.test.ts` (offline, injected fake client): routing (`lmstudio`, `lmstudio:<id>`, empty override rejected, `gpt-5`/`gpt-5-mini` still OpenAI); endpoint (default, `LMSTUDIO_BASE_URL`, explicit option wins); no-cloud-key construction and the placeholder credential asserted with both cloud keys set; no-fallback (`name` is neither `openai` nor `anthropic` with both keys set); model discovery probed once and memoized, empty list errors, explicit id never probes; unreachable-server, tools-unsupported, and 429-passthrough errors; native tool-call mapping, catalog advertisement, nudge on prose calls (both `"tool"` and `"name"` spellings), no nudge for prose / out-of-catalog names / no-tools turns
- [x] 5.2 Add `OpenAIProvider` regression coverage to the same file (still throws without `OPENAI_API_KEY`; `gpt-5` default and explicit id; conversation mapping and vendor `extra` preservation), since it had no offline tests before this change
- [x] 5.3 Extend the `providers` array in `test/agent-integration.test.ts` with an `lmstudio` entry gated on `COPPERHEAD_TEST_LMSTUDIO=1` (AC-3.10), mirroring the `COPPERHEAD_TEST_CODEX` gate — a running local server cannot be inferred from any credential's presence
- [x] 5.4 Generalize the `check`-is-LLM-free import scan in `test/init-check.test.ts` to cover `export bom` as well, and to reject any network client (`node:http`/`node:https`, `undici`, `axios`, `got`, `fetch`) rather than only providers and model SDKs. A local provider makes the old `api.*` host assertion insufficient, since a configured endpoint may be `localhost`; the scan proves both commands cannot reach any host (AC-2.6). `execa` stays allowed: kicad-cli is a subprocess, not a network client

## 6. SPEC & verification

- [x] 6.1 Update `openspec/specs/SPEC.md`: extend AC-3.10 to include `--model lmstudio`; tighten AC-2.1 from "no network to api.* hosts" to zero requests to any host and add AC-2.6 (offline by construction, covering `check` and `export bom`); add AC-3.21 (local model, no key, no cloud call, no fallback, actionable local failures); add `lmstudio.ts` to the §2 tree and §4.4 provider list; add `LMSTUDIO_BASE_URL` to the `.env.example` reference
- [x] 6.2 Run `npm run build`, `npm run typecheck`, and `npm test` (full offline suite green, including the new provider tests); if the `openspec` CLI is available, run `openspec validate add-lmstudio-provider` and fix fallout

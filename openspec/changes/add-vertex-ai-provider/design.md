# Design — Vertex AI provider

## D1. Selection is a `vertex:` model prefix, not a backend flag on `claude`

**Decision.** Route on `vertex` / `vertex:<model-id>` through the existing `resolveModel()` precedence chain, matched as its own namespace before the `claude*` prefix is considered. Project and region are *settings* carried in config/env, never selectors.

**Rejected alternative: a `COPPERHEAD_ANTHROPIC_BACKEND=vertex` switch that redirects the existing `claude` route.** This is what Claude Code does with `CLAUDE_CODE_USE_VERTEX=1`, and it was rejected for the same reason D1 of the compat change rejected `COPPERHEAD_PROVIDER`: it creates a second selector alongside `resolveModel()`, whose chain is currently the single answer to "which model runs". It is also worse than the compat case, because the redirect is invisible in the one place a user looks — the model string stays `claude`, so `--model claude` means "first-party API" on one machine and "Vertex" on another, and a run transcript recording `model: claude` no longer says where the request went. `vertex:` puts the backend in the model string, which run metadata (AC-8.1/8.2) already records.

**Rejected alternative: reusing `compat:` against Vertex's OpenAI-compatible endpoint.** That endpoint requires a Google OAuth access token in the `Authorization` header. The user would have to run `gcloud auth print-access-token`, export it into the variable `COPPERHEAD_API_KEY_ENV` names, and redo that every hour when it expires. It also gives up the Anthropic-native request shape — the three `cache_control` breakpoints copperhead relies on to keep a resent conversation prefix cheap (SPEC.md §4.5) have no equivalent on the OpenAI wire format, so long runs would cost several times more.

## D2. Bare `vertex` has a default model; bare `compat` does not

**Decision.** `vertex` with no id resolves to the same default model as the `claude` route, exported from one shared constant that both providers import.

The compat route rejects its bare form because a compatible endpoint serves whatever models its host chooses — there is no id that is ever right to assume. Vertex is not that: it serves the Claude family under ids that match the first-party API, so the `claude` route's default is exactly as correct here as it is there. Sharing one constant rather than repeating the literal is what keeps that true after the next default bump; two copies would drift silently, and the failure mode — a stale id that Vertex 404s — looks like a Vertex misconfiguration rather than a copperhead bug.

The one thing Vertex adds is that the model must also be enabled in the project's Model Garden. Copperhead cannot check that offline, so it is left to Google's own error on the first turn (D6).

## D3. Reject the dated-id form rather than translate it

**Decision.** `vertex:claude-opus-4-5-20251101` fails at provider construction with a message naming `claude-opus-4-5@20251101`. Copperhead does not rewrite the id.

Vertex separates a dated snapshot with `@`; the first-party API uses `-`. Both are plausible to type, one is silently wrong, and the resulting failure is a bare 404 from Google that names neither form. A construction-time rejection costs one regex and turns that into a fix.

Translating instead of rejecting was considered and dropped: it would mean copperhead deciding that a `-YYYYMMDD` suffix is *always* a date rather than part of a model name, which is a guess about ids that don't exist yet. Rejecting states the rule without betting on it. This is the only id manipulation on the route; everything else passes through verbatim, so a model released after this build works with no code change (the same principle as the other prefix routes).

## D4. One shared request shape, two clients

**Decision.** Extract the Anthropic request building and response parsing — cache-breakpoint placement, tool-use/tool-result block mapping, cache-inclusive token accounting — into a shared module. `anthropic.ts` and `vertex.ts` each own only client construction and their `name`.

`AnthropicVertex` exposes the same `messages.create` surface as `Anthropic`, so the alternative is copying ~60 lines of block-mapping into a second file. That copy is the kind that rots: the cache-breakpoint placement was tuned deliberately (`turn-budget-continue-and-loop-efficiency`, "Anthropic prompt caching"), and a future adjustment applied to one file and not the other would show up as a quiet cost regression on whichever route was missed, not as a test failure.

**Rejected alternative: `class VertexProvider extends AnthropicProvider`.** Cheaper to write, but it makes `name` and the client constructor the only two things a subclass may safely override while leaving every other member implicitly shared. Composition states the seam instead of relying on nobody adding a method that assumes an API key.

## D5. `name: 'vertex'` — the failover rule is the reason, not bookkeeping

**Decision.** The provider reports `name: 'vertex'`, distinct from `'anthropic'`.

`otherProvider()` (loop.ts) reads: an `'anthropic'` provider that is rate-limited fails over to OpenAI if a key exists. A Vertex provider naming itself `'anthropic'` would inherit that, and a 429 on a governed GCP project would silently move the run — and the design being worked on — onto whatever personal `OPENAI_API_KEY` happened to be exported. For a user who chose Vertex specifically for billing, audit, residency, or a VPC-SC perimeter, that is the failure the route exists to prevent. Vertex takes the same no-failover treatment as `codex`, `claude-code`, `cursor`, and `compat`.

## D6. `doctor` checks ADC by presence, on disk, and stops there

**Decision.** `doctor` reports the resolved project and region, and looks for a credential *source*: `GOOGLE_APPLICATION_CREDENTIALS` pointing at a file that exists, the gcloud ADC file (`$CLOUDSDK_CONFIG`, else the platform default location), or a metadata-server environment. No project or no source is a `fail` with the `gcloud auth application-default login` hint.

`doctor` is contractually network-free, which rules out minting a token, calling Vertex, or asking whether the model is enabled in Model Garden. The check that remains is genuinely useful — an unconfigured machine is the common case, and it is caught in milliseconds — and it is honest about its limit: a present but expired or unauthorised credential passes `doctor` and fails on the first turn, exactly as a syntactically valid but revoked API key does today on every other route.

## D7. Vertex gets an `info` privacy line, not the Gemini `warn`

**Decision.** The Vertex route reports `info`: the project's Google Cloud terms govern it. `TRAINING_RISK_HOSTS` is not extended to Vertex.

`generativelanguage.googleapis.com` is already flagged `warn` on the compat route because its free tier may train on submitted prompts. Vertex is the same vendor and a different product: a paid enterprise endpoint under the customer's own cloud agreement. Emitting the free-tier warning there would be a false positive of exactly the kind D5 of the compat change warned about — the one that teaches users to ignore the warning that is real. Saying nothing at all is the other failure, since a user who has read the Gemini warning will reasonably wonder whether it applies; the `info` line answers that.

## D8. Optional dependency, lazily imported, and the core SDK must move

**Decision.** `@anthropic-ai/vertex-sdk` is an `optionalDependency` behind a lazy `await import()`, matching `@openai/codex-sdk` and `@anthropic-ai/claude-agent-sdk`. It pulls `google-auth-library`, which no other route needs.

This forces a change the proposal calls out and tasks must sequence first: the current `@anthropic-ai/vertex-sdk` peers on `@anthropic-ai/sdk >=0.115.1 <1`, and copperhead pins `^0.113.0` — a range that cannot satisfy it. The core SDK moves to `^0.122.0`. That bump lands on the existing `claude` route as well as the new one, so it is verified there before the Vertex work starts, not alongside it: a regression on `claude` after both changes have landed would otherwise be attributed to the wrong one.

## D9. No response-cache change

**Decision.** Leave the cache key alone.

The compat route had to add `baseURL` to the key because a model id like `llama-3.1-8b-instant` is served by several hosts and is not unique. Vertex has no such collision: the key already contains the resolved model string, and that string is `vertex:claude-opus-5`, not `claude-opus-5`. Project and region are deliberately *not* in the key either — the same model in `us-east5` and in `global` is the same model, and keying on region would orphan every cached turn the first time someone moved a project's region for latency.

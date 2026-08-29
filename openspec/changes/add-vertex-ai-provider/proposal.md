# Add a Google Cloud Vertex AI provider route

## Why

Copperhead can reach Claude models exactly one way: `AnthropicProvider`, hardcoded to `new Anthropic({ apiKey })` from `ANTHROPIC_API_KEY`. Organisations that buy Claude through Google Cloud have no first-party key to give it — their spend, quota, audit trail, data-residency commitment, and VPC-SC perimeter all live in a GCP project, and their credential is ADC (a service account or `gcloud auth application-default login`), not an `sk-ant-` string. For those users copperhead is simply unusable on Claude, which is the model family its prompts and cache-breakpoint strategy are tuned for.

The `compat:` route does not close this gap. Vertex's OpenAI-compatible endpoint still requires a short-lived Google OAuth access token, so a user would have to mint one themselves and re-export it into `COPPERHEAD_API_KEY_ENV` every hour. Vertex needs real ADC-aware client construction, not a base URL.

## What Changes

- New `vertex.ts` provider built on `AnthropicVertex` from `@anthropic-ai/vertex-sdk`, authenticating via Google Application Default Credentials. No Anthropic API key is read, set, or required on this route.
- New `vertex` / `vertex:<model-id>` model route in `makeProvider()`, matching the prefix idiom of `codex`, `claude-code`, `cursor`, and `compat`. Bare `vertex` selects the same default model id as the `claude` route, from one shared constant so the two cannot drift.
- The Anthropic request shaping (three `cache_control` breakpoints, tool-use/tool-result block mapping, cache-inclusive token accounting) is extracted to a shared module and used by both `anthropic.ts` and `vertex.ts`, so the two backends cannot diverge on the wire format.
- New config fields `vertexProject` and `vertexRegion`, overridable by `COPPERHEAD_VERTEX_PROJECT` / `COPPERHEAD_VERTEX_REGION`, falling back last to the Vertex SDK's own `ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION`. Region defaults to `global`; project has no default and is a fail-fast error.
- Vertex model ids are passed through verbatim, with one guard: an Anthropic-API-style dated id (`claude-opus-4-5-20251101`) is rejected before any network call with a message naming the Vertex `@` form (`claude-opus-4-5@20251101`).
- `copperhead doctor` gains a Vertex branch: it reports the resolved project and region, and checks offline whether ADC is discoverable (`GOOGLE_APPLICATION_CREDENTIALS`, the gcloud ADC file, or a metadata-server environment). It stays network-free — it never mints a token or calls Vertex.
- `doctor`'s prompt-privacy line distinguishes Vertex from the `generativelanguage.googleapis.com` free tier it already warns about: Vertex is a paid enterprise endpoint under GCP terms, so it reports `info`, not `warn`.
- A rate-limited Vertex run never fails over to a keyed provider. The provider reports `name: 'vertex'` so `otherProvider()`'s `anthropic → openai` rule cannot silently move a governed run onto a paid first-party account.
- `vertex` is never an auto-fallback candidate in `resolveModel()`: like `compat`, it is reachable only by explicit selection.
- Transcript redaction (AC-4.1) covers Google credential shapes: bare `ya29.` access tokens and PEM private-key blocks from a service-account JSON.
- A `vertex` entry in the live AC-3.x provider-parity matrix, skipped unless `COPPERHEAD_TEST_VERTEX=1` and a project are configured.

## Capabilities

### New Capabilities

- `vertex-ai-provider`: Claude on Google Cloud Vertex AI — ADC authentication, project/region resolution, model-id form, shared request shaping with the Anthropic API provider, and the no-failover rule.

### Modified Capabilities

- `agent-core`: the provider list gains the Vertex route; `makeProvider()` gains Vertex settings; the keyed-provider failover rule is narrowed to exclude Vertex.
- `cli-surface`: `--model` / `COPPERHEAD_MODEL` / `config.model` accept `vertex` and `vertex:<id>`; `.copperhead/config.json` accepts `vertexProject` and `vertexRegion`; `doctor` reports Vertex project, region, and ADC presence.
- `safety-rails`: write-time redaction covers Google OAuth access tokens and PEM private-key blocks.

## Impact

- **Dependency bump required.** `@anthropic-ai/vertex-sdk` (currently 0.19.6) peers on `@anthropic-ai/sdk >=0.115.1 <1`; copperhead pins `^0.113.0`, which cannot satisfy it. The core SDK must move to `^0.122.0` — the same peer-satisfaction step already taken for `@anthropic-ai/claude-agent-sdk` (SPEC.md §4.4). The bump affects the existing `anthropic` route, so the AC-3.x matrix must be re-run for `claude` as well as `vertex`.
- `@anthropic-ai/vertex-sdk` ships as an `optionalDependency` and is lazily imported only when the `vertex` route is selected, matching the `@openai/codex-sdk` and `@anthropic-ai/claude-agent-sdk` pattern. It pulls `google-auth-library`, which is why it is not a hard dependency.
- `check` unchanged: still LLM-free and network-free.
- `doctor` remains network-free; ADC is probed by filesystem and environment presence only.
- No response-cache change. The resolved model string already carries the `vertex:` prefix, so a Vertex turn and a first-party turn on the same model id do not share cache entries.
- No structural effect on the two invariants: spec-gating and verification-gating are provider-agnostic.
- Model ids and per-region availability live in docs, not code. Vertex additionally requires the model to be enabled in the project's Model Garden, which copperhead cannot check offline; that failure surfaces on the first real turn with Google's own error.

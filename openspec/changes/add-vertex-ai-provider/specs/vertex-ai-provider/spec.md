# vertex-ai-provider — Delta Spec

## Purpose

Runs Claude models through Google Cloud Vertex AI, so an organisation whose Claude access, billing, quota, and audit trail live in a GCP project can use copperhead with its existing Application Default Credentials instead of a first-party Anthropic API key.

## ADDED Requirements

### Requirement: Vertex authenticates via Application Default Credentials
The Vertex provider SHALL authenticate using Google Application Default Credentials and SHALL NOT read, require, or send `ANTHROPIC_API_KEY`. A run on this route SHALL succeed with no Anthropic API key present anywhere in the environment, and SHALL NOT be affected by one that is present.

#### Scenario: no Anthropic API key is needed
- **GIVEN** ADC are available and a Vertex project is configured, with `ANTHROPIC_API_KEY` unset
- **WHEN** a run starts with `--model vertex:<model-id>`
- **THEN** the provider is constructed successfully and its requests are authenticated with a Google credential

#### Scenario: a present Anthropic key does not change the route
- **GIVEN** `ANTHROPIC_API_KEY` is set in the environment
- **WHEN** a run starts with `--model vertex:<model-id>`
- **THEN** the request still goes to Vertex under the Google credential, and the Anthropic key is neither read nor sent

### Requirement: Project is required, region defaults to `global`
The Vertex provider SHALL resolve its GCP project and region before any network call. Resolution precedence SHALL be `COPPERHEAD_VERTEX_PROJECT` / `COPPERHEAD_VERTEX_REGION`, then `vertexProject` / `vertexRegion` in `.copperhead/config.json`, then the Vertex SDK's own `ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION`. An unresolved region SHALL default to `global`. An unresolved project SHALL be a fail-fast error naming every variable and config field that could supply it; there is no safe default project.

#### Scenario: environment overrides config
- **GIVEN** `vertexProject` is set in `.copperhead/config.json` and `COPPERHEAD_VERTEX_PROJECT` is exported with a different value
- **WHEN** Vertex settings are resolved
- **THEN** the environment value wins, matching the precedence direction of every other copperhead setting

#### Scenario: a machine already configured for Vertex needs no copperhead-specific settings
- **GIVEN** only `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` are set, with no copperhead Vertex config
- **WHEN** Vertex settings are resolved
- **THEN** those values are used

#### Scenario: a missing project fails before any network call
- **GIVEN** no project is resolvable from environment or config
- **WHEN** a run starts with `--model vertex`
- **THEN** it fails immediately with a message naming the settings that could supply a project, and no request is made

#### Scenario: region defaults to global
- **GIVEN** a project is configured and no region is set anywhere
- **WHEN** Vertex settings are resolved
- **THEN** the region is `global`

### Requirement: Vertex model ids pass through, with the dated-id form rejected
`vertex:<model-id>` SHALL send `<model-id>` to Vertex verbatim, so a model released after this build works without a code change. Bare `vertex` SHALL select the same default model id as the `claude` route, from a single shared definition so the two cannot drift. An empty override (`vertex:`) SHALL be rejected. A model id carrying an Anthropic-API-style dated suffix (`-YYYYMMDD`) SHALL be rejected before any network call, with a message naming the Vertex `@YYYYMMDD` form, because that id shape is valid on the first-party API and invalid on Vertex.

#### Scenario: an unknown model id is passed through
- **WHEN** a run starts with `--model vertex:<some-future-model-id>`
- **THEN** that id is sent to Vertex unchanged, and any rejection comes from Vertex rather than from copperhead

#### Scenario: bare `vertex` uses the shared default model
- **WHEN** a run starts with `--model vertex`
- **THEN** it uses the same default model id the `claude` route uses

#### Scenario: an empty override is rejected
- **WHEN** `--model vertex:` is resolved
- **THEN** the run fails with a message telling the user to use `vertex` or `vertex:<model-id>`

#### Scenario: an Anthropic-style dated id is corrected, not sent
- **WHEN** a run starts with `--model vertex:claude-opus-4-5-20251101`
- **THEN** it fails before any network call with a message naming the Vertex form `claude-opus-4-5@20251101`

### Requirement: Vertex and the Anthropic API share one request shape
The Vertex and Anthropic API providers SHALL build their requests and parse their responses through one shared definition, so both apply the same `cache_control` breakpoints (system prompt, last tool definition, last block of the final message), the same tool-use and tool-result block mapping, and the same cache-inclusive input-token accounting. A change to that shape SHALL take effect on both routes at once.

#### Scenario: prompt caching applies on Vertex
- **GIVEN** a multi-turn Vertex run
- **WHEN** the conversation prefix is resent on a later turn
- **THEN** the same three cache breakpoints are marked as on the Anthropic API route, and reported input tokens include cache reads and writes

#### Scenario: tool calls round-trip identically
- **GIVEN** the same conversation and tool list
- **WHEN** it is sent on the Vertex route and on the Anthropic API route
- **THEN** the request body differs only in model id and endpoint, and both parse tool calls and usage the same way

### Requirement: A rate-limited Vertex run never fails over to a keyed provider
The Vertex provider SHALL be structurally distinguishable by name from the Anthropic API and OpenAI providers, so `otherProvider()`'s keyed-provider failover never redirects a Vertex run onto `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Moving a run governed by a GCP project's quota, audit trail, and data-residency commitment onto a personal first-party account SHALL NOT happen silently.

#### Scenario: a Vertex provider is never eligible for the keyed failover
- **GIVEN** a `vertex:<model-id>` run with both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` present in the environment
- **WHEN** Vertex returns a rate-limit response and backoff is exhausted
- **THEN** the run fails rather than failing over, and the provider's name is distinct from `'openai'` and `'anthropic'`

### Requirement: Vertex is opt-in only
`resolveModel()` SHALL NOT select the Vertex route automatically. Vertex SHALL be reachable only by explicit selection through `--model`, `COPPERHEAD_MODEL`, or `config.model`, and the presence of GCP credentials or Vertex settings in the environment SHALL NOT make it an auto-fallback candidate.

#### Scenario: configured Vertex settings do not hijack auto-selection
- **GIVEN** `COPPERHEAD_VERTEX_PROJECT` is exported and exactly one of `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is set, with no explicit model selection
- **WHEN** the model is resolved
- **THEN** the keyed provider is selected as before, and Vertex is not considered

### Requirement: The Vertex SDK is optional and lazily loaded
`@anthropic-ai/vertex-sdk` SHALL be an optional dependency, imported only when the Vertex route is selected. An install without it SHALL leave every other route working, and selecting `vertex` without it SHALL fail with a message naming the package to install.

#### Scenario: other routes work without the optional package
- **GIVEN** `@anthropic-ai/vertex-sdk` is not installed
- **WHEN** a run starts with `gpt-5`, `claude`, `codex`, `claude-code`, `cursor`, or `compat:<id>`
- **THEN** it behaves exactly as before, and the package is never imported

#### Scenario: a missing package gives an actionable error
- **GIVEN** `@anthropic-ai/vertex-sdk` is not installed
- **WHEN** a run starts with `--model vertex`
- **THEN** it fails with a message naming the package to install

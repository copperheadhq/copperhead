# agent-core — Delta Spec

## ADDED Requirements

### Requirement: Provider list includes Vertex AI
The provider list (§4.4) SHALL include a Vertex AI provider: Claude models served through a GCP project, authenticated by Application Default Credentials rather than a model API key, selected by `vertex` / `vertex:<model-id>`. `makeProvider()` SHALL accept optional Vertex settings (project, region) alongside the model string; the parameter is optional, so callers that do not use the Vertex route are unaffected.

#### Scenario: the vertex route reaches the configured project
- **GIVEN** Vertex settings resolved from environment or config
- **WHEN** `makeProvider()` is called with `vertex:<model-id>`
- **THEN** it returns the Vertex provider bound to that project, region, and model id

#### Scenario: existing routes are unaffected
- **WHEN** `makeProvider()` is called with `gpt-5`, `claude`, `codex`, `claude-code`, `cursor`, or `compat:<id>`
- **THEN** routing is exactly as before, and no Vertex setting is consulted

#### Scenario: `vertex` is matched as its own namespace
- **WHEN** `makeProvider()` is called with `vertex` or `vertex:<model-id>`
- **THEN** it routes to the Vertex provider and is never captured by the `claude*` prefix or the OpenAI catch-all

### Requirement: Keyed failover excludes Vertex
The rate-limit failover rule SHALL remain limited to the two keyed HTTP providers (`openai` ↔ `anthropic`). Saved-login providers (`codex`, `claude-code`, `cursor`), the compatible-endpoint provider, and the Vertex provider SHALL never fail over to a keyed or alternate provider. For Vertex specifically, failing over would move a run off the GCP project that carries its billing, quota, audit trail, and data-residency commitment.

#### Scenario: a rate-limited Vertex run fails rather than switching providers
- **GIVEN** a `vertex:<model-id>` run with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` both present
- **WHEN** Vertex rate-limits the run and backoff is exhausted
- **THEN** the run fails with the rate-limit error; no request is made to either keyed provider

### Requirement: Provider parity covers Vertex AI
AC-3.10 provider parity SHALL include `--model vertex:<model-id>` when a Vertex project and ADC are configured for the test run, and SHALL skip it otherwise so the default suite stays offline and free.

#### Scenario: the live matrix runs the Vertex provider only when configured
- **GIVEN** `COPPERHEAD_TEST_VERTEX=1` and a resolvable Vertex project
- **WHEN** the live acceptance suite runs
- **THEN** the AC-3.x cases execute against Vertex; absent either, they are skipped

# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `vertex` model selection and project configuration
`--model`, `COPPERHEAD_MODEL`, and the `model` field in `.copperhead/config.json` SHALL accept `vertex` and `vertex:<model-id>`, routed to the Vertex provider in `makeProvider()`. `.copperhead/config.json` SHALL accept `vertexProject` (string) and `vertexRegion` (string), overridable by `COPPERHEAD_VERTEX_PROJECT` and `COPPERHEAD_VERTEX_REGION` respectively, with the environment taking precedence over config.

#### Scenario: vertex routes without model API keys
- **WHEN** `--model vertex` is resolved
- **THEN** the run uses the Vertex provider and does not require `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`

#### Scenario: environment overrides config
- **GIVEN** `vertexRegion` is set in `.copperhead/config.json` and `COPPERHEAD_VERTEX_REGION` is exported
- **WHEN** Vertex settings are resolved
- **THEN** the environment value wins

### Requirement: `doctor` reports Vertex project, region, and ADC presence
`copperhead doctor` SHALL, for the Vertex route, report the resolved project and region and check offline whether Application Default Credentials are discoverable — via `GOOGLE_APPLICATION_CREDENTIALS` pointing at an existing file, a gcloud ADC file on disk, or a metadata-server environment. It SHALL `fail` with an actionable hint when no project is resolvable or no credential source is discoverable. It SHALL make no network request: it SHALL NOT mint a token, call Vertex, or check whether the model is enabled in the project's Model Garden; those surface on the first real run instead.

#### Scenario: doctor passes on a configured Vertex machine
- **GIVEN** a resolvable project and a gcloud ADC file on disk
- **WHEN** `copperhead doctor --model vertex` runs
- **THEN** the provider check passes and its detail names the project and region

#### Scenario: missing credentials give an actionable hint
- **GIVEN** a resolvable project and no discoverable ADC source
- **WHEN** `copperhead doctor --model vertex` runs
- **THEN** the provider check fails with a hint naming `gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`

#### Scenario: missing project is reported as a failure
- **GIVEN** no project is resolvable from environment or config
- **WHEN** `copperhead doctor --model vertex` runs
- **THEN** the provider check fails naming the settings that could supply a project

#### Scenario: doctor never makes a network request for Vertex
- **GIVEN** any Vertex configuration, valid or not
- **WHEN** `copperhead doctor --model vertex` runs
- **THEN** no network request is made and no reachability or model-availability line is reported

### Requirement: `doctor` does not carry the Gemini free-tier warning onto Vertex
`copperhead doctor`'s prompt-privacy line SHALL treat Vertex as a paid enterprise endpoint governed by the customer's Google Cloud terms, reporting `info` rather than the `warn` it emits for a host documented as training on submitted prompts. The existing warning for `generativelanguage.googleapis.com` (reached through the `compat` route) SHALL NOT be extended to the Vertex route on the basis of a shared vendor.

#### Scenario: a Vertex run gets an info line, not a training warning
- **WHEN** `copperhead doctor --model vertex` runs with a configured project
- **THEN** the privacy line is `info`, states that Google Cloud terms govern the project, and the command exits 0

#### Scenario: the compat-route Gemini warning is unchanged
- **WHEN** `copperhead doctor --model compat:<model-id>` runs against `generativelanguage.googleapis.com`
- **THEN** the `warn` line is emitted exactly as before

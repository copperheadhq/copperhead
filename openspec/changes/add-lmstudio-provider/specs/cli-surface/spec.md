# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `lmstudio` model selection values
`--model`, the `COPPERHEAD_MODEL` env var, and the `model` field in `.copperhead/config.json` SHALL accept `lmstudio` (a local OpenAI-compatible server on whichever model it has loaded) and `lmstudio:<model-id>` (the same server on a specific model id). These values SHALL route to the `lmstudio` provider and SHALL be matched **before** the catch-all route that sends any unrecognized string to the OpenAI API, so a local run is never sent to `api.openai.com`. An empty override (`lmstudio:`) SHALL be rejected with a message naming the two valid forms. The existing values (`codex`, `claude-code`, `claude`, `claude-<id>`, `gpt-5`, and any other string to OpenAI) SHALL keep their current routing.

#### Scenario: lmstudio routes to the local provider
- **WHEN** `--model lmstudio` (or `--model lmstudio:qwen2.5-coder-32b`) is resolved
- **THEN** the run uses the `lmstudio` provider against the configured local endpoint and requires no API key

#### Scenario: OpenAI routing is unaffected
- **WHEN** `--model gpt-5` or `--model gpt-5-mini` is resolved
- **THEN** the run uses the OpenAI API provider exactly as before, keyed by `OPENAI_API_KEY`

#### Scenario: Empty model override is rejected
- **WHEN** `--model lmstudio:` is resolved
- **THEN** the command fails with an error naming `lmstudio` and `lmstudio:<model-id>` as the accepted forms

### Requirement: A local server is never auto-selected
Model resolution SHALL keep its precedence chain (flag > `COPPERHEAD_MODEL` > config > available API key) and SHALL NOT probe for or fall back to a local server when no model is otherwise configured. Model resolution SHALL remain synchronous and free of network access. The error raised when no model can be resolved SHALL name `--model lmstudio` among the available options.

#### Scenario: No implicit local fallback
- **WHEN** no model is configured by flag, env, or config, and no API key is present, while a local LM Studio server is running
- **THEN** the command exits with the no-model-configured error rather than silently using the local server, and that error names `--model lmstudio` as one of the ways to proceed

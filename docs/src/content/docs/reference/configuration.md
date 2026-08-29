---
title: Configuration
description: Config file keys, environment variables, model selection, and the files copperhead writes.
sidebar:
  order: 2
---

## `.copperhead/config.json`

Written by `copperhead init`. Every key is optional; the defaults below apply when a key is absent or the file does not exist.

```json
{
  "schematic": "hardware/board.kicad_sch",
  "board": "hardware/board.kicad_pcb",
  "docs": "docs/",
  "model": null,
  "maxTurns": 40,
  "maxRepairCycles": 5,
  "budgets": {
    "sleep_current_uA": 25
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `schematic` | `null` | Path to the `.kicad_sch`, relative to the repo root. ERC is skipped when null. |
| `board` | `null` | Path to the `.kicad_pcb`. DRC is skipped when null. |
| `docs` | `"docs/"` | The design docs directory: [docs-as-memory](/concepts/docs-as-memory/). |
| `model` | `null` | Default model. Overridden by `--model` and `COPPERHEAD_MODEL`. |
| `maxTurns` | `40` | Turn budget per run. |
| `maxRepairCycles` | `5` | ERC/DRC repair attempts before the run rolls back to the git snapshot. |
| `budgets` | `{}` | Free-form hard constraints, surfaced verbatim into every run's system prompt. |
| `baseURL` | unset | Base URL of an OpenAI-compatible endpoint. Read **only** by the `compat` model route. |
| `apiKeyEnv` | `OPENAI_API_KEY` | Name of the environment variable holding that endpoint's key. The name, never the key itself. |

There is also a `generatedHashes` key, maintained by copperhead. It records content hashes of the generated docs so `init` can tell an untouched file from a hand-edited one. Do not edit it by hand.

### Budgets

Budgets are hard constraints, not hints. A change that would exceed one is refused with an explanation, rather than accepted and discovered later:

```json
{
  "budgets": {
    "sleep_current_uA": 25,
    "bom_cost_usd": 18.50
  }
}
```

The names are yours. copperhead passes them through verbatim and expects the units to be in the key, as in `sleep_current_uA`.

## `.copperhead/constraints.json`

The constraint registry: machine-readable counterparts to the constraints stated in your design docs. Constraints are dual-written, to the doc and to the registry, and the sync-obligations ledger refuses to let a run commit if one was updated without the other.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI credentials. |
| `ANTHROPIC_API_KEY` | Anthropic API credentials. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional. Saved-login token for `--model claude-code` (see below). Minted by `claude setup-token`; lets you run against a Claude subscription with no `ANTHROPIC_API_KEY`. |
| `COPPERHEAD_MODEL` | Default model. Overrides config, overridden by `--model`. |
| `COPPERHEAD_CODEX_PATH` | Optional path to a `codex` executable. Defaults to `codex` on `PATH`; the SDK-bundled launcher is a fallback. |
| `COPPERHEAD_CURSOR_PATH` | Optional path to the Cursor Agent CLI (`agent` / `cursor-agent`). Defaults to `agent` on `PATH`. |
| `COPPERHEAD_BASE_URL` | Optional. Overrides `baseURL`. Only the `compat` route reads it, so it never redirects a `gpt-5` run. |
| `COPPERHEAD_API_KEY_ENV` | Optional. Overrides `apiKeyEnv`, e.g. `GROQ_API_KEY`. |
| `NO_COLOR` | Optional. Disables ANSI colors in `doctor` output; colors are also skipped automatically when stdout is not a terminal. |

A `.env` file in the working directory is read at startup, before any command resolves a model or a provider. A real environment variable always wins over the file. Copy `.env.example` to get started.

Keys are read from the environment only. copperhead never writes one to a config file, and redacts anything matching `sk-[A-Za-z0-9_-]+` when writing transcripts and summaries. Keep `.env` out of git; the shipped `.gitignore` already excludes it.

For `--model codex`, the read-only sandbox blocks native writes but does not restrict native reads to the temporary working directory. Avoiding Codex's own filesystem tools is therefore prompt-enforced. The Codex CLI also stores its own session logs under `~/.codex/sessions/`; those logs can contain prompt and design content and are outside copperhead's `.copperhead/runs/` redaction guarantee.

## Model selection

Resolved in strict precedence order:

1. The `--model` flag
2. `COPPERHEAD_MODEL`
3. `model` in `.copperhead/config.json`
4. `gpt-5` if `OPENAI_API_KEY` is set, otherwise `claude` if `ANTHROPIC_API_KEY` is set
5. In the interactive shell on a TTY: an arrow-key model picker (other commands fail with an error at this point)

Set any of the first three to `codex` to use the installed Codex CLI and its saved ChatGPT login without a model API key. Plain `codex` uses your Codex default; `codex:<model-id>` selects an explicit Codex model. Run `codex login status` to verify authentication.

If `codex` is not on `PATH`, point `COPPERHEAD_CODEX_PATH` at an executable explicitly. The optional SDK includes one at `node_modules/@openai/codex/bin/codex.js`; for a global installation, `$(npm root -g)/@openai/codex/bin/codex.js` resolves its path.

If none of these produce a model, the command exits with an error telling you the available ways to set one. `check` never needs a model, since it makes no LLM calls at all.

Accepted model values (routing is by prefix; `makeProvider` checks `vertex`, then `compat`, then `codex`, then `claude-code`, then `cursor`, then `claude`, then OpenAI):

Two rows below both mention "OpenAI," but mean different things - worth pulling apart before the table:

- **`gpt-5`** talks to OpenAI's own service, running OpenAI's own models. Needs `OPENAI_API_KEY`.
- **`compat:<id>`** talks to somebody else's service - Google's Gemini servers, Groq's servers, OpenRouter's servers, or your own machine running Ollama. None of them are OpenAI. They're called "OpenAI-**compatible**" only because those companies chose to format their requests the same way OpenAI does, so copperhead can talk to them with the same code it already has for `gpt-5` - just pointed at a different address (`baseURL`) with a different key.

So every other row below is a dedicated integration for one specific vendor's login or API. `compat:<id>` is the odd one out: a generic bridge that works for any of them, precisely because it assumes nothing about which one you're using.

| Value | Provider | Key |
| --- | --- | --- |
| `compat:<id>` | Any OpenAI-compatible endpoint (Groq, OpenRouter, Gemini, Ollama) | the variable named by `apiKeyEnv`; none for a local endpoint |
| `codex` / `codex:<id>` | Codex CLI, saved login | none (local Codex login) |
| `claude-code` / `claude-code:<id>` | Claude Code, saved login | none (uses `CLAUDE_CODE_OAUTH_TOKEN` / your logged-in CLI) |
| `cursor` / `cursor:<id>` | Cursor Agent CLI, saved login | none (`agent login`) |
| `claude` / `claude-<id>` | Anthropic API | `ANTHROPIC_API_KEY` |
| `vertex` / `vertex:<id>` | Claude via Google Cloud Vertex AI | none (Google ADC + a GCP project; see below) |
| `gpt-5` / anything else | OpenAI API | `OPENAI_API_KEY` |

`claude-code` is matched before the `claude` prefix, so it is never captured by the Anthropic API route. Cursor runs report 0 token usage (CLI JSON has no usage fields).

For `compat:<id>`, set `baseURL` (env `COPPERHEAD_BASE_URL` or `.copperhead/config.json`) and, if the endpoint needs a key, `apiKeyEnv` (env `COPPERHEAD_API_KEY_ENV` or config). Each resolves independently - env wins over config for whichever one it sets - so you can mix sources, e.g. `baseURL` in config with `COPPERHEAD_API_KEY_ENV` as an env var. `baseURL` is required for every compat endpoint. Non-local endpoints (Gemini, Groq, OpenRouter) also need the actual key, held in the variable `apiKeyEnv` names (defaults to `OPENAI_API_KEY` if left unset) - a local endpoint (Ollama) can skip the key entirely. The three pieces below are always: the endpoint, the name of the env var holding the key, and that env var itself.

**Gemini:**

```bash
export COPPERHEAD_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
export COPPERHEAD_API_KEY_ENV=GEMINI_API_KEY
export GEMINI_API_KEY=...
export COPPERHEAD_MODEL=compat:<model-id>   # or pass --model compat:<model-id> instead, per command
copperhead do "..."
```

**Groq:**

```bash
export COPPERHEAD_BASE_URL=https://api.groq.com/openai/v1
export COPPERHEAD_API_KEY_ENV=GROQ_API_KEY
export GROQ_API_KEY=...
export COPPERHEAD_MODEL=compat:<model-id>   # or pass --model compat:<model-id> instead, per command
copperhead do "..."
```

**OpenRouter:**

```bash
export COPPERHEAD_BASE_URL=https://openrouter.ai/api/v1
export COPPERHEAD_API_KEY_ENV=OPENROUTER_API_KEY
export OPENROUTER_API_KEY=...
export COPPERHEAD_MODEL=compat:<model-id>   # or pass --model compat:<model-id> instead, per command
copperhead do "..."
```

**Ollama (local, no key):**

```bash
export COPPERHEAD_BASE_URL=http://localhost:11434/v1
export COPPERHEAD_MODEL=compat:<model-id>   # or pass --model compat:<model-id> instead, per command
copperhead do "..."
```

A local endpoint needs no key of its own, but `COPPERHEAD_API_KEY_ENV` still defaults to `OPENAI_API_KEY` when left unset, and whatever that variable holds is sent to the endpoint as a bearer token - including over the LAN if `baseURL` points at another machine (e.g. a `.local` hostname), not just loopback. If you have `OPENAI_API_KEY` exported for normal `gpt-5` use, as in the example `.env` above, that key will be sent to Ollama too unless you point `COPPERHEAD_API_KEY_ENV` at an unset variable to suppress it. Only the `compat` route reads `baseURL`, so leaving any of these set does not affect `gpt-5` or any other model.

The model id after `compat:` is whatever that provider calls it (check their model list - ids and availability change over the ones shown above). `baseURL` must be the OpenAI-compatible base path specifically (the `/v1`, or `/v1beta/openai/` for Gemini), not the provider's general API root.

### Claude via Google Cloud Vertex AI

`--model vertex` (or `vertex:<model-id>`) runs Claude through your GCP project instead of the first-party Anthropic API - for organisations whose Claude spend, quota, audit trail, and data-residency commitment live in Google Cloud. **This is not the `compat:` Gemini route above**: it speaks the Anthropic-native protocol (so prompt caching works exactly as on `claude`), it authenticates with Google Application Default Credentials rather than an API key of any kind, and it does not carry the Gemini free-tier training-risk warning - Vertex is a paid enterprise endpoint governed by your project's own Google Cloud terms (`doctor` reports this as an `info` line).

```bash
gcloud auth application-default login     # once; or GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
export COPPERHEAD_VERTEX_PROJECT=my-gcp-project    # required; no default
export COPPERHEAD_VERTEX_REGION=global             # optional; defaults to "global"
copperhead do "..." --model vertex
```

`vertexProject` and `vertexRegion` in `.copperhead/config.json` work too; the environment wins over config, and the Vertex SDK's own `ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION` are honoured last, so a machine already configured for Vertex needs nothing copperhead-specific. Only the `vertex` route reads any of these.

Bare `vertex` uses the same default model as `claude`. A specific model id is passed to Vertex verbatim, with one guard: Vertex dates snapshot ids with `@` (`claude-opus-4-5@20251101`), and the Anthropic-API-style `-20251101` form is rejected before any network call with the corrected id. The model must also be enabled in your project's Model Garden - copperhead cannot check that offline, so it surfaces on the first turn with Google's own error. A rate-limited Vertex run never fails over to a keyed provider: moving a governed GCP run onto a personal `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is exactly what this route exists to avoid.

### Saved login (Claude Code)

`--model claude-code` drives Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) and reuses your saved login (the `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`), so a Claude subscription user runs copperhead with **no `ANTHROPIC_API_KEY`**. copperhead uses Claude Code purely as a reasoning backend: the agent loop, its safety gates (snapshot, ERC/DRC verification, rollback, commit gate), and every file edit stay inside copperhead exactly as with the other providers.

One-time setup:

1. The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) ships as an optional dependency of copperhead, so a normal install includes it and no separate step is needed. If you installed with `--omit=optional` and it is missing, copperhead loads it lazily and errors actionably, telling you to add it with `npm i @anthropic-ai/claude-agent-sdk`.
2. Be logged into Claude Code, then run `claude setup-token` and export the result as `CLAUDE_CODE_OAUTH_TOKEN` (use `--model claude-code:<id>` to pick a specific model).

Authentication stays entirely with the CLI: copperhead never reads, copies, or logs the credential. A missing dependency or an unauthenticated install fails with an actionable message and leaves your tree untouched, and a rate-limited `claude-code` run never silently falls back to a billed API provider.

### Saved login (Cursor Agent)

`--model cursor` drives the Cursor Agent CLI with your saved login from `agent login`, so you can run copperhead with **no model API keys**. Cursor runs in plan mode with sandbox enabled; copperhead maps tool calls through the same JSON prompt protocol as `claude-code` and keeps every mutation inside its own gated loop.

1. Run `agent login` and verify with `agent status`.
2. Run copperhead with `--model cursor` (use `--model cursor:<id>` for an explicit model).

If `agent` is not on `PATH`, set `COPPERHEAD_CURSOR_PATH`. A rate-limited `cursor` run never silently falls back to a billed API provider.

## Files copperhead writes

| Path | Committed? | What it is |
| --- | --- | --- |
| `docs/*.md` | Yes | Design docs. The agent's memory and its output. |
| `.copperhead/config.json` | Yes | Configuration. |
| `.copperhead/constraints.json` | Yes | Constraint registry. |
| `.copperhead/README.md` | Yes | Self-describing docs for the above. |
| `.copperhead/runs/<ts>/` | No | JSONL transcript plus a human-readable `summary.md`. Gitignored. |

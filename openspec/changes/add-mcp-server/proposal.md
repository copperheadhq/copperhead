# add-mcp-server: Proposal

## Why

Coding agents (Claude Code, Codex, Cursor, and every MCP host) are already being pointed at KiCad repos through raw tool servers that expose ungated file edits: the host agent can rewrite a `.kicad_sch` with no spec gate, no verification, no rollback. Copperhead's invariants only protect users whose entry point is the copperhead CLI, and that is a shrinking share of how people work. A thin MCP wrapper makes the gated pipeline the thing the host agent calls, so the invariants survive the integration and copperhead meets the agent audience where it already works (roadmap Phase 3, items 1 and 2).

## What Changes

- **New command: `copperhead mcp`**, a stdio MCP server exposing the pipeline as opaque tools:
  - `copperhead_check` — runs the LLM-free `check` pipeline and returns the JSON report.
  - `copperhead_do` — takes a change-request string, runs the full gated `do` loop (spec gate, edit, verify, repair, rollback), and returns the run summary (result, commit, files touched, verification state, transcript path). The host agent never sees or drives intermediate steps.
  - `copperhead_sync` — verify phase always; resolve phase only when the `resolve` input is true.
  - `copperhead_init` — scaffolds docs-memory in a KiCad repo.
  - `copperhead_doctor` — probes the environment (node, kicad-cli, git, openspec, model credential) and returns the report. LLM-free, network-free, mutates nothing; it exists so a host can diagnose its own setup instead of failing opaquely.
- **Experimental surface, unstable protocol.** The server ships behind a declared unstable protocol version and is documented as experimental: the tool set, input schemas, and result shapes may change in any release. No registry submission and no stability promise until the stabilization criteria below are met. This is what keeps a fast-moving CLI from owing a contract to hosts it cannot migrate.
- **Structural opacity**: the server exposes no file-edit, no raw KiCad, and no partial-loop tools. There is nothing to reach around; a host agent integrating copperhead cannot bypass spec-gating or verification-gating by construction. The tool set is deliberately a subset of the CLI, not a mirror of it.
- **Safety inheritance**: dirty-tree refusal, path sandbox, secret redaction, and budgets apply unchanged; the MCP layer adds no privileges. `copperhead_do` runs non-interactive (AUTO marker), and the server refuses `do`/`sync --resolve` when no API key env var is present, with a message distinguishing agent-loop tools from the LLM-free ones.
- **Companion skill**: a Claude Code / Codex skill instructing agents to use these tools instead of editing `.kicad_*` files directly, shipped in the repo under `integrations/`. A skill is prompt-level guidance, not enforcement — it narrows the sanctioned path for hosts that read it and is explicitly not a substitute for the server's structural opacity.

## Stabilization criteria

The experimental marker comes off, and registry listings are submitted, when all of:

- The run-protocol handshake (`copperhead capabilities --json` and a `copperhead-run/<major>` protocol constant) exists, and the server reports its surface through it rather than through a local version constant.
- The five tool input schemas carry an explicit version and have stopped changing shape. (The shared result envelope and its typed error kinds are adopted in this change, so that half of the tool frame is already in place.)
- The tool set has gone one minor release without an input-schema or result-shape change.

Until then `copperhead mcp` prints its experimental status on startup and the README documents the surface as unstable.

## Capabilities

### New Capabilities

- `mcp-server`: the `copperhead mcp` command, the five tool contracts (inputs, outputs, error shapes), the opacity guarantee, the experimental/unstable-protocol declaration, and non-interactive/key-handling semantics.

### Modified Capabilities

- `cli-surface`: the CLI gains the `mcp` command, marked experimental in help output.

## Impact

- **Code**: new `src/mcp/server.ts` (stdio transport, tool schemas, dispatch into the existing command entry points). The entry points already exist and return structured results — `runCheck`, `syncVerify` / `syncResolve`, `runInit`, and `runAgentLoop` — so this change consumes them and adds typed error mapping rather than refactoring the command layer.
- **Dependencies**: `@modelcontextprotocol/sdk` (runtime); no transport beyond stdio in this change.
- **Distribution**: the companion skill under `integrations/`; registry submission deferred until the stabilization criteria are met.
- **Unchanged contracts**: CLI behavior identical; no new network surface (stdio only; LLM calls happen exactly where the CLI already makes them).

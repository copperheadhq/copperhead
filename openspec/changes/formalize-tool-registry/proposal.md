# formalize-tool-registry: Proposal

## Why

The tool system is a flat `TOOLS` array with boolean gating and plain-string results. Skills already exist as `STAGES` in `create`, but they are a second, hardcoded registry the model cannot see. Issue #246's later phases (part-research, MCP, host skills) need one catalog, versioned schemas, structured results, and a `gate()` predicate — none of which exist yet. Formalizing that frame now is what those surfaces reuse; building them against the flat list would freeze the wrong shape.

## What Changes

- **One two-tier catalog.** Atomic tools (tier 1) and composed skills (tier 2) register through the same path and appear as one tool list to the model. Dispatch picks the tier: a tool runs its handler; a skill runs a nested `runAgentLoop` and returns one envelope to the parent.
- **`ToolRegistry` replaces the flat array.** Lookup by name, `list(ctx)` applying each entry's `gate()`, schema `version`, and a registry protocol version. `requiresUnlock: boolean` becomes `gate: (ctx) => boolean`.
- **Structured `ToolResult` envelope** `{ ok, summary, detail?, data?, error?, viewHint? }`. Providers still receive a flattened string (backward compatible). The renderer reads `ok` / `viewHint` instead of regex-guessing pass/fail from prose.
- **Typed error kinds** `unavailable` / `validation` / `refusal` / `exception`, with envelope construction as the redaction boundary (`data` never carries a secret-shaped payload to render or dock).
- **Skill contract.** A skill declares its tool subset, prompt, completion gate, and optional turn budget. Its default `gate` is the conjunction of those tools' gates, so a skill that lists `edit_file` is structurally absent until the proposal validates — by construction.
- **Proof skill `generate_report`.** Read-only (`read_file`, `search`, `list_nets`, `run_erc`, `run_drc`, `export_svg`, `check_drift`). Always available; cannot write. Nested loop returns the report as the envelope. `create`'s `STAGES` are **not** migrated in this change.
- **CLI form** `copperhead skill run generate-report`, the same definition as the model-facing tool, so the skill is testable without a provider key.

## Capabilities

### New Capabilities

- `tool-registry`: the two-tier catalog, versioned schemas, `ToolResult` envelope, `gate()` predicates, skill sub-run contract, `generate_report` as the proof skill, and the `copperhead skill run` CLI.

### Modified Capabilities

- `agent-core`: the loop consumes the registry; dispatch returns envelopes that flatten to today's string for providers; a skill call is a nested `runAgentLoop` whose parent sees one result, not the inner transcript.
- `cli-surface`: the CLI gains `skill run <name>`.
- `spec-gating`: gating is a `gate()` predicate on each catalog entry; a skill's effective gate is at least as strict as every tool it declares; the structural test remains absence from `list(ctx)`, not a dispatch-time `unavailable` error.
- `safety-rails`: envelope `data` is redacted at construction; the render/dock path never receives a raw secret-shaped payload. `check`/`verify` stay LLM-free and network-free (AC-2.1).

## Impact

- **Code:** new `src/capabilities/` (`HANDLERS` table wrapped by `defineTool`, one file per skill, barrel); `src/agent/tools.ts` is registry + dispatch + skill sub-run; loop, providers, `render.ts` / `dock-renderer.ts` / `theme.ts` consume envelopes; `src/commands/skill.ts` for the CLI form.
- **Tests:** `gating-sync` keeps the absence assertion (`edit_file` not in `list(ctx)`); envelope assertions are additive; conformance test over every registered entry; offline `skill run` via stub provider; redaction test that a key-shaped token never reaches the renderer.
- **Docs:** SPEC.md §4.2 tool table becomes the catalog (tools + skills); skill CLI lands in §3.
- **Unchanged contracts:** spec-gated edit tools remain structurally absent until a proposal validates; verification-gated completion is unchanged; a skill sub-run cannot clear parent obligations via `finish`; `check` imports no capability module; `STAGES` stay in `create.ts`.
- **Out of scope:** part-research tools (#41 / `add-part-research-tools`), MCP server and host skills (#40 / `add-mcp-server`), migrating `create` stages onto the skill registry.

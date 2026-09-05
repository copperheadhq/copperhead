# formalize-tool-registry: Design

## Context

Today there are two capability systems that do not know about each other. `TOOLS: ToolDef[]` in `src/agent/tools.ts` is 23 entries, `requiresUnlock: boolean`, handlers returning `Promise<string>`. `STAGES` in `src/commands/create.ts` is a skill registry under another name: each stage has `name`, `isComplete`, and `prompt`, and `create` executes one by calling `runAgentLoop`. The model sees only the flat tool list. `theme.ts` classifies a tool result by regex on its first line. There is no schema version, no structured envelope, and no `gate()` predicate — so the research tools' condition (`research.enabled` AND keys present) and any future skill would each grow a second gating path.

Issue #246 owns this stream. This change is Phase 0, option 2: framework plus one proof skill. Part-research (#41), MCP (#40), and migrating `STAGES` are out of scope.

## Goals / Non-Goals

**Goals:**

- One catalog the model sees; dispatch picks atomic tool vs skill.
- `gate()` as the single gating mechanism; spec-gating of `edit_file`/`write_file` stays an absence-from-list invariant, proven by test.
- Structured `ToolResult` envelopes; renderer reads `ok` / `viewHint`.
- Envelope `data` redacted at construction; render/dock never see a raw secret-shaped payload.
- Proof skill `generate_report` plus nested sub-run, with CLI `copperhead skill run generate-report`.
- `check`/`verify` remain LLM-free and network-free (AC-2.1).

**Non-Goals:**

- Migrating `STAGES` onto the skill registry (follow-up; `stage-completion.test.ts` and the `create-*.test.ts` files stay put).
- Part-research tools, MCP server, Claude Code / Codex companion skills.
- Changing provider wire formats beyond flattening the envelope to today's string `Msg` tool content.
- A new network surface, a new LLM SDK, or any change to the `check` module graph.

## Decisions

### D1. One catalog, two tiers; dispatch picks the tier

```
catalog:  [read_file, edit_file, run_erc, ..., generate_report]
             |______ tier 1: atomic ______|   |____ tier 2 ____|
```

`registry.list(ctx)` returns every entry whose `gate(ctx)` is true. Names are unique across both tiers. A skill presents as a tool in the provider's schema list (name, description, parameters). `dispatch(name)` looks up the entry: tier 1 runs `handler`; tier 2 runs the nested sub-run (D6) and returns one envelope.

Alternative considered: keep skills out of the model catalog and inject their prompts into the current loop. Rejected — that forfeits budget isolation and a real completion contract, which is exactly what makes create stages recoverable today.

### D2. `gate()` predicate replaces `requiresUnlock`

```ts
gate: (ctx: RunContext) => boolean
```

Edit tools: `gate: (ctx) => ctx.editsUnlocked`. Research tools (later): `gate: (ctx) => enabled && keysPresent`. A boolean cannot express the second without a parallel filter. One predicate is the project's established "absent, not discouraged" idiom.

`availableTools(ctx)` becomes `registry.list(ctx)` filtered to the requested tier, or the combined catalog. Off-catalog rejection in `parseToolCalls` is unchanged: it still takes a `Set` of names from `list(ctx)`.

### D3. A skill's default gate is the conjunction of its tools' gates

```ts
gate?: (ctx) => boolean  // default: every declared tool's gate(ctx) is true
```

Load-bearing. A skill that lists `edit_file` is structurally absent from `list(ctx)` until the proposal validates, by construction. Without this default the skill tier is the hole in invariant 1. A skill MAY supply a stricter `gate`; it MUST NOT supply a weaker one. The conformance test (D8) asserts the effective gate is at least as strict as every declared tool.

Worked example: `generate_report` declares `[read_file, search, list_nets, run_erc, run_drc, export_svg, check_drift]` — no mutation tools — therefore always available and provably unable to write.

### D4. Envelope at the handler boundary; flatten for providers

```ts
interface ToolResult {
  ok: boolean;
  summary: string;     // one line the renderer shows
  detail?: string;     // what the model reads (flattened)
  data?: unknown;      // structured payload, redacted at construction
  error?: { kind: 'unavailable' | 'validation' | 'refusal' | 'exception'; message: string };
  viewHint?: 'diagnostic' | 'mutation' | 'query' | 'export';
}
```

Catalog handlers return `ToolResult`. The legacy `HANDLERS` table may return prose for operations whose outcome is the operation itself, or `{ ok, text }` when the handler already knows a separate domain outcome (ERC/DRC/drift/symbol/legibility diagnostics and multi-artifact exports). The barrel converts either form to one envelope before dispatch returns it. This prevents a known failing diagnostic from being re-inferred from prose. The loop (1) records the envelope on the transcript, (2) flattens `summary` + `detail` (or `error.message`) into the string `Msg` tool content providers already consume, (3) hands the envelope to the renderer.

Flattening preserves today's gating-sync substrings: an unavailable edit tool's `error.message` still contains `"not available"` and `"unlock"`. The absence assertion `expect(registry.list(ctx).map(e => e.name)).not.toContain('edit_file')` is the invariant; the envelope `kind === 'unavailable'` assertion is additive, never a replacement.

`data` is passed through `redactSecrets` (and the `*_KEY`/`*_SECRET`/`*_TOKEN` value set) at envelope construction. Renderers receive the already-redacted envelope. They never call `JSON.stringify` on unredacted handler output.

Unsuccessful domain outcomes without an invocation error keep their `detail` when flattened. Typed invocation errors still flatten to `error.message`.

### D5. Schema version on each entry; protocol version on the registry

Each tool and skill carries `version: number` (schema of its parameters + result). The registry exposes a protocol version for the envelope shape. Provider adapters keep sending `{ name, description, parameters }` over the wire; `version` stays in our catalog so MCP hosts can cache a tool list later without this change taking a dependency on MCP.

### D6. Nested sub-run, not a second `do`

A skill call is **not** `runAgentLoop` as `do`/`create` call it. The outer loop owns git preflight, snapshot, commit, and OpenSpec archive. A nested skill that went through that path would snapshot mid-run, commit out from under the parent, or archive a change the parent still holds.

The nested path is a turn-loop extract:

- Shares the parent's `RunContext` ledger, transcript, and `editsUnlocked`.
- Own messages, own `maxTurns` (skill default or arg), own tool subset (`skill.tools` resolved against the registry).
- No git snapshot, no commit, no `openspec archive`.
- Completes when `isComplete(ctx, args)` is true or the turn budget is exhausted; the parent receives one envelope.
- Provider turns inherit the main loop's bounded turn timeout and 429 retry policy. An exhausted timeout, rate limit, or other provider exception is converted by dispatch into a failed `exception` envelope; it never escapes the parent loop.
- Inner tool results are retained in call order, including repeated calls to the same tool. An incomplete skill returns every partial result it gathered.
- `finish` is forbidden in a skill's `tools` array (conformance test). The nested loop does not put `finish` in the child catalog. Even if a future caller forced it, `finishRequest` on the shared ctx MUST NOT trigger the parent's commit; the nested path never reads it for that purpose.

Verification-gating stays with the parent: a skill that somehow mutated would open obligations on the shared ledger, and the parent's `finish` would still refuse. `generate_report` cannot mutate, so this is a structural backstop for later skills, not a generate_report concern.

Alternative: inject skill instructions into the current loop. Rejected (D1). Alternative: spawn a full `runAgentLoop`. Rejected because of snapshot/commit.

### D7. `generate_report` is the proof skill; `STAGES` stay put

Read-only report of the current design state. Parameters: `{ scope: 'power' | 'all' }` (default `all`). The nested loop uses the declared tools and returns `summary` + `detail` as the report (ERC/DRC/drift status, net count, SVG path if exported). It does not call `write_file`; the report is the envelope. The CLI prints that envelope; the parent transcript records it.

`STAGES` remain hardcoded in `create.ts`. Migrating them is a later change so this one does not move `stage-completion.test.ts` and the six `create-*.test.ts` files in the same diff as the registry.

### D8. Handlers table + skill modules, identity `defineTool`/`defineSkill`, barrel + conformance

```
src/capabilities/
  handlers.ts                atomic tools (schema + string handler + requiresUnlock)
  index.ts                   wrap HANDLERS via defineTool; import each skill
  skills/generate-report.ts  export default defineSkill({ ... })
```

Atomic tools stay one table so a new tool is one `HANDLERS` entry, not a stub file plus a barrel line. Skills remain one module each — they have a prompt, tool subset, and completion contract that a table row cannot hold. `defineTool` / `defineSkill` are identity functions for inference and defaults (`gate` conjunction, `version` required). `src/agent/tools.ts` keeps `RunContext`, dispatch, and the nested skill sub-run.

Conformance test over every registered entry:

- names unique across both tiers
- `version` and `viewHint` set
- catalog tool names match `HANDLERS` 1:1
- every skill `tools` name resolves
- a skill's effective gate is at least as strict as each declared tool
- every file under `src/capabilities/skills/` is imported by the barrel (an unregistered skill file fails CI)

Existing tools keep their current names, schemas, and observable string summaries after flattening, so provider integration tests and `gating-sync` stay green.

### D9. CLI form is the same definition

```
copperhead skill list
copperhead skill run generate-report [--scope power|all]
```

`skill list` is LLM-free, network-free, and filesystem-side-effect-free: it prints registered skills and whether `gate(ctx)` would include them without initializing a transcript. `skill run` invokes D6's nested sub-run (it needs a model, same as `do`) and prints the envelope. Tests call the exported runner with a `ScriptedProvider` (already used in `test/observability.test.ts`) so the suite stays offline. Missing key on `skill run` is a typed error naming the env var, not a stack trace.

`check`/`verify` do not import `src/capabilities/`. The module-graph guard in `test/init-check.test.ts` keeps scanning outward from `src/commands/check.ts`.

### D10. Renderer reads `ok` / `viewHint`; retry maps from error kind

`toolLine` uses `result.ok` for the glyph, not `/\b(clean|ok|pass(?:ed)?|success|done)\b/i`. Diagnostics that already have a structured result set `ok` from that result (for example `CheckReport.ok`), never from a prefix in formatted prose. `viewHint` selects layout (diagnostic vs mutation vs query vs export). `validation` and `refusal` are not retried; thrown 429s use `src/util/retry.ts`; `unavailable` is not retried.

## Risks / Trade-offs

- [Envelope refactor weakens `gating-sync`] → keep `expect(registry.list(ctx).map(e => e.name)).not.toContain('edit_file')`; keep `"not available"` / `"unlock"` in the unavailable message; add `error.kind === 'unavailable'` alongside, never instead.
- [Nested `runAgentLoop` snapshots or commits] → D6 is a turn-loop extract, not `do`. Tests assert a skill call does not create a git snapshot, a commit, or an OpenSpec archive.
- [Skill lists `finish` and launders an unverified mutation] → conformance forbids `finish` in `tools`; nested path never consults `finishRequest` for commit; parent ledger still blocks.
- [File split of `tools.ts` is a large mechanical diff] → one commit-worth of moves with behavior-preserving flatten; existing handler strings become `summary`/`detail` so golden tests that match result text stay stable.
- [Third-party bytes on the render path in later phases] → redaction at envelope construction now, with a test that a key-shaped token in `data` never reaches the renderer verbatim. Phase 2 rides this.
- [`check` accidentally imports the registry] → module-graph guard stays pointed at `src/commands/check.ts`; `src/capabilities/` is not on that graph.

## Migration Plan

1. Land types, envelope helpers (including redaction-at-construction), and `ToolRegistry` wrapping the current `TOOLS` array with `gate: (ctx) => !requiresUnlock || ctx.editsUnlocked`. No behavior change.
2. Wrap `HANDLERS` into the catalog, add `skills/*`, barrel + conformance. Flattened strings stay identical.
3. Nested sub-run + `generate_report` + `copperhead skill list`/`run`.
4. Renderer switches from regex to `ok`/`viewHint`.
5. On archive: SPEC.md §4.2 documents the catalog (tools + skills) and §3 gains `skill`.

Rollback: revert the change. No config flag — this is the new tool frame, not an opt-in. Existing `do`/`create`/`check` contracts are preserved by flattening and by leaving `STAGES` in place.

## Open Questions

- Skill names in the model catalog: `generate_report` (underscore, matches tools) vs `generate-report` (CLI kebab). Leaning underscore in the catalog and kebab in the CLI, mapped by the skill command, so the model sees one naming convention.
- Whether inner skill turns share the parent's JSONL transcript as nested events or write a sibling `skill-<name>.jsonl`. Leaning nested events in the same transcript so one run dir stays the audit trail.
- Default `maxTurns` for `generate_report`. Leaning 8 — enough for ERC+DRC+drift+a handful of reads, far under `do`'s 40.

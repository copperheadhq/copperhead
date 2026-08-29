# formalize-tool-registry: Tasks

## 1. Envelope and registry (no behavior change)

- [x] 1.1 Add `ToolResult`, `ViewHint`, `ToolErrorKind`, `gate()`, and schema `version` types; add identity `defineTool` / `defineSkill` with skill default-gate conjunction
- [x] 1.2 Implement envelope helpers: `ok`/`fail` constructors, flatten-to-string for provider `Msg` content, redaction of `data`/`summary`/`detail`/`error.message` at construction via existing `redactSecrets`
- [x] 1.3 Implement `ToolRegistry` (`get`, `list(ctx)`, protocol version) wrapping the current `TOOLS` array with `gate: (ctx) => !requiresUnlock || ctx.editsUnlocked`
- [x] 1.4 Point `availableTools` / `dispatchTool` at the registry; preserve today's flattened strings including `"not available"` / `"unlock"` on a locked `edit_file` dispatch
- [x] 1.5 Unit tests: flatten, typed error kinds, redaction-at-construction (key-shaped token stripped before the object is returned)

## 2. Capability files and conformance

- [x] 2.1 Wrap existing handlers via `defineTool` in the barrel (`version`, `viewHint`, same handler behavior); skills stay one file each under `src/capabilities/skills/`
- [x] 2.2 Barrel `src/capabilities/index.ts`; `src/agent/tools.ts` keeps `RunContext`, dispatch, and the nested skill sub-run
- [x] 2.3 Conformance test: unique names, `version`/`viewHint` set, catalog tools match `HANDLERS`, barrel imports every `skills/` file, skill `tools` resolve, skill effective gate at least as strict as each declared tool, no skill lists `finish`
- [x] 2.4 `gating-sync` keeps `expect(list(ctx).map(e => e.name)).not.toContain('edit_file')` (and `write_file`); envelope `unavailable` assertion is additive; `"not available"` / `"unlock"` substrings still pass

## 3. Loop, providers, renderer

- [x] 3.1 Loop obtains the per-turn catalog from `registry.list(ctx)`, records the envelope on the transcript, flattens for the provider `Msg`
- [x] 3.2 Providers keep sending `{ name, description, parameters }`; `parseToolCalls` catalog `Set` still comes from `list(ctx)` (off-catalog stays prose)
- [x] 3.3 `theme.ts` / `render.ts` / `dock-renderer.ts` read `result.ok` and `viewHint`; delete the pass/fail regex heuristic in `toolLine`
- [x] 3.4 Retry: `validation`/`refusal`/`unavailable` are not retried; `exception` uses `src/util/retry.ts`
- [x] 3.5 Render-path redaction test: a handler payload containing `sk-` or a `*_KEY` env value never appears in the renderer input or the printed tool line

## 4. Nested sub-run

- [x] 4.1 Extract a nested turn-loop path that shares parent ledger/transcript/`editsUnlocked`, applies a tool-name subset and `maxTurns`, and does not git-snapshot, commit, or `openspec archive`
- [x] 4.2 Nested path never consults `finishRequest` for commit; `finish` is not placed in a skill child catalog
- [x] 4.3 Dispatch of a skill name runs the nested path and returns one envelope to the parent
- [x] 4.4 Tests: parent records one tool result per skill call; no extra commit / archive; parent `finishRequest` unchanged after the skill returns

## 5. generate_report and CLI

- [x] 5.1 Register skill `generate_report` (`scope: power|all`, default `all`, `maxTurns` 8, tools `read_file`/`search`/`list_nets`/`run_erc`/`run_drc`/`export_svg`/`check_drift`, no mutation tools); report is the envelope, no report file written
- [x] 5.2 CLI `copperhead skill list` (LLM-free, network-free) and `copperhead skill run <name>` (kebab CLI name maps to underscore catalog name)
- [x] 5.3 `skill run` missing-key path: non-zero exit, env var or login named, no stack trace; unknown name: non-zero, name in the message
- [x] 5.4 Export a runner that tests invoke with a `ScriptedProvider` so `skill run generate-report` is covered offline
- [x] 5.5 `copperhead --help` lists `skill`

## 6. Scenario tests (map 1:1 to delta specs)

- [x] 6.1 tool-registry: combined catalog; dispatch picks skill tier; unknown name → `unavailable`; every entry versioned; successful flatten; locked `edit_file` flatten; validation not retried
- [x] 6.2 tool-registry: locked list omits edit tools; unlock is presence; default skill gate hides locked skills; `generate_report` present while locked; weaker skill gate fails conformance; no skill lists `finish`
- [x] 6.3 tool-registry: parent sees one envelope; nested run is not a `do`; always-available / cannot-write / report-is-envelope for `generate_report`; unregistered file fails CI; unique names
- [x] 6.4 spec-gating: pre-validation list; unlock after validate; absence-from-list is the invariant; skill cannot smuggle `edit_file`; gating-sync has both assertions
- [x] 6.5 agent-core: provider still sees strings; off-catalog stays prose; inner turns do not commit; nested finish cannot satisfy the parent
- [x] 6.6 cli-surface: help lists `skill`; `skill list` LLM-free on the fixture; `skill run generate-report` with ScriptedProvider; run without a key; unknown skill
- [x] 6.7 safety-rails: key-shaped token never reaches the renderer; transcript still redacted; `check` module-graph guard excludes `src/capabilities/` and provider SDKs (AC-2.1)

## 7. Docs and archive prep

- [x] 7.1 Draft SPEC.md edits for archive time: §4.2 becomes the two-tier catalog (existing tools + `generate_report`); §3 gains `skill list` / `skill run`
- [x] 7.2 README: document `copperhead skill list` / `skill run generate-report` and that `create` stages are not yet skills
- [x] 7.3 Confirm `STAGES` in `src/commands/create.ts` is untouched; `npm run typecheck && npm test` green; `npm run build` for the CLI command

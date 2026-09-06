# tool-registry — Spec

## ADDED Requirements

### Requirement: Two-tier catalog
The agent SHALL expose a single catalog of named entries in two tiers: atomic tools (tier 1) and skills (tier 2). Names SHALL be unique across both tiers. The catalog presented to the provider SHALL be exactly `registry.list(ctx)`: every entry whose `gate(ctx)` is true, and no other. Dispatch SHALL select the tier by name: a tool runs its handler; a skill runs the nested sub-run defined by this capability and returns one `ToolResult` to the caller.

#### Scenario: Combined catalog
- **WHEN** `registry.list(ctx)` is computed with edits locked
- **THEN** the returned names include `read_file` and `generate_report`, and include neither `edit_file` nor `write_file`

#### Scenario: Dispatch picks the tier
- **WHEN** the model calls `generate_report`
- **THEN** dispatch runs the skill sub-run rather than a tier-1 handler, and the parent receives a single `ToolResult` envelope

#### Scenario: Unknown name is not dispatched
- **WHEN** `dispatchTool` is called with a name that is not in `registry.list(ctx)`
- **THEN** it returns an envelope with `ok: false` and `error.kind` `unavailable`, and no handler runs

### Requirement: Versioned schemas
Every catalog entry SHALL carry a positive integer `version` for its parameter/result schema. The registry SHALL expose a protocol version for the `ToolResult` envelope shape. Provider adapters SHALL continue to send `{ name, description, parameters }` on the wire; they MUST NOT drop an entry because it has a `version`.

#### Scenario: Every registered entry is versioned
- **WHEN** the conformance test enumerates the registry
- **THEN** every tool and skill has a `version >= 1`

### Requirement: ToolResult envelope
Every tool and skill invocation SHALL return a `ToolResult` of the form `{ ok, summary, detail?, data?, error?, viewHint? }`. `error.kind`, when present, SHALL be one of `unavailable`, `validation`, `refusal`, `exception`. The loop SHALL flatten `summary` plus `detail` (or `error.message` on failure) into the string tool-result content providers already consume. `viewHint` SHALL be one of `diagnostic`, `mutation`, `query`, `export`.

#### Scenario: Successful flatten
- **WHEN** a tool returns `{ ok: true, summary: "ERC clean", detail: "0 violations" }`
- **THEN** the provider-facing tool message contains `ERC clean` and `0 violations`, and the renderer is given the envelope (not a reconstructed string)

#### Scenario: Unavailable flatten preserves the lock phrasing
- **WHEN** `edit_file` is dispatched while edits are locked
- **THEN** the envelope has `ok: false`, `error.kind` `unavailable`, and `error.message` contains both `not available` and `unlock`

#### Scenario: Typed validation error is not retried
- **WHEN** a handler returns `error.kind` `validation` or `refusal`
- **THEN** the loop does not retry that call

#### Scenario: Diagnostic outcome is not inferred from prose
- **WHEN** ERC returns a report with `ok: false` formatted as `ERC: 3 violation(s)`
- **THEN** the tool envelope has `ok: false`, the renderer does not show the success glyph, and the provider-facing text still contains the violation detail

#### Scenario: Unsuccessful detail is preserved
- **WHEN** an unsuccessful domain-result envelope has `detail` but no typed invocation `error`
- **THEN** flattening includes both its summary and detail

#### Scenario: Unverifiable is not failure
- **WHEN** a diagnostic's findings are all "could not check" rather than divergences, as `verify_symbols` reports on a machine where the referenced libraries are not installed
- **THEN** the envelope has `ok: true`, because the tool found zero issues to reconcile, and the renderer does not show a failure glyph for it

### Requirement: Predicate gating
Each catalog entry SHALL declare `gate: (ctx) => boolean`. An entry whose gate returns false SHALL be absent from `registry.list(ctx)` and SHALL NOT appear in the tool list sent to the provider. A boolean `requiresUnlock` field SHALL NOT exist on the catalog type.

#### Scenario: Locked edit tools are absent from the list
- **WHEN** `ctx.editsUnlocked` is false
- **THEN** `registry.list(ctx).map(e => e.name)` does not contain `edit_file` or `write_file`

#### Scenario: Unlock is presence, not a dispatch warning
- **WHEN** `ctx.editsUnlocked` becomes true after a validated proposal
- **THEN** subsequent `registry.list(ctx)` includes `edit_file` and `write_file`

### Requirement: Skill contract
A skill SHALL declare `name`, `version`, `description`, `parameters`, `tools` (a list of catalog names), `prompt(ctx, args)`, and `isComplete(ctx, args)`. It MAY declare `maxTurns` and `gate`. When `gate` is omitted, the skill SHALL be available only if every declared tool's `gate(ctx)` is true. A supplied `gate` MUST NOT be weaker than that conjunction. A skill's `tools` array SHALL NOT include `finish`.

#### Scenario: Default gate hides locked skills
- **WHEN** a skill declares `edit_file` in `tools` and edits are locked
- **THEN** that skill is absent from `registry.list(ctx)`

#### Scenario: Read-only skill stays present
- **WHEN** `generate_report` is registered with only read-only tools and edits are locked
- **THEN** `generate_report` is present in `registry.list(ctx)`

#### Scenario: Weaker gate is rejected
- **WHEN** the conformance test inspects a skill whose declared `gate` would return true while one of its tools' gates returns false
- **THEN** the test fails

#### Scenario: finish is not a skill tool
- **WHEN** the conformance test inspects every skill's `tools` array
- **THEN** none contains `finish`

### Requirement: Nested skill sub-run
A skill invocation SHALL run a nested turn loop that shares the parent's ledger, transcript, and `editsUnlocked`; uses only the skill's declared tool subset; applies the skill's `maxTurns` (or the skill's default); and does not take a git snapshot, commit, or OpenSpec archive. The sub-run SHALL end when `isComplete` is true or the turn budget is exhausted, and SHALL return one `ToolResult` to the parent. The nested path SHALL NOT treat `finishRequest` as a signal to commit.

#### Scenario: Parent sees one envelope
- **WHEN** the parent loop dispatches `generate_report`
- **THEN** the parent records one tool result for that call, not one result per inner turn

#### Scenario: Nested run is not a do
- **WHEN** `generate_report` completes inside a parent `do` run
- **THEN** git history gains no extra commit from the skill, and `openspec/` is not archived by the skill

#### Scenario: Shared ledger keeps obligations
- **WHEN** a nested skill (in a future mutation skill) would open a sync obligation
- **THEN** that obligation remains on the parent's ledger after the skill returns

#### Scenario: Provider error is contained
- **WHEN** a provider throws inside a nested skill turn
- **THEN** dispatch returns an envelope with `ok: false` and `error.kind: exception`, rather than letting the rejection escape the parent loop

#### Scenario: Nested provider recovery is bounded
- **WHEN** a nested provider turn returns 429 or exceeds `turnTimeoutMs`
- **THEN** the sub-run applies bounded backoff or timeout retries using the main loop policy and eventually returns or fails as one envelope

#### Scenario: Partial and repeated results survive
- **WHEN** a skill exhausts its turn budget after calling the same tool more than once
- **THEN** its unsuccessful envelope retains every gathered result in call order, including repeated calls

### Requirement: generate_report proof skill
The catalog SHALL include a skill `generate_report` with parameters `{ scope: "power" | "all" }` (default `"all"`), tools `read_file`, `search`, `list_nets`, `run_erc`, `run_drc`, `export_svg`, and `check_drift`, and a default `maxTurns` of 8. It SHALL NOT declare any mutation tool (`edit_file`, `write_file`, or any other `gate` that requires `editsUnlocked`). The report SHALL be the returned envelope (`summary` + `detail`); the skill SHALL NOT write a repo file to hold the report.

#### Scenario: Always available
- **WHEN** edits are locked and no OpenSpec change is in flight
- **THEN** `generate_report` is in `registry.list(ctx)`

#### Scenario: Cannot write
- **WHEN** `generate_report`'s declared `tools` are resolved
- **THEN** the set contains none of `edit_file`, `write_file`, `propose_change`, or `finish`

#### Scenario: Report is the envelope
- **WHEN** `generate_report` completes with `scope: "all"`
- **THEN** the envelope `ok` reflects whether ERC, DRC (if a board exists), and drift were obtained, `summary` is one line, `detail` contains those results, and no new repo file was created to hold the report

### Requirement: Capability layout and conformance
Atomic tools SHALL be declared in `src/capabilities/handlers.ts` and wrapped into the catalog through `defineTool` in the barrel. Each skill SHALL live in its own module under `src/capabilities/skills/`, imported by that barrel. `defineTool` and `defineSkill` SHALL apply defaults (including the skill gate conjunction). A conformance test SHALL fail if a skill file is not imported by the barrel, if catalog tool names do not match `HANDLERS` 1:1, if two entries share a name, if `version` or `viewHint` is missing, if a skill names an unknown tool, or if a skill's effective gate is weaker than any of its tools.

#### Scenario: Unregistered skill file fails CI
- **WHEN** a file exists under `src/capabilities/skills/` that the barrel does not import
- **THEN** the conformance test fails

#### Scenario: Unique names
- **WHEN** the conformance test enumerates the registry
- **THEN** no two entries share a `name`

#### Scenario: Isolated registry construction is isolated
- **WHEN** a second `ToolRegistry` is constructed from entries returned by the singleton registry
- **THEN** binding default skill gates in the second registry does not mutate the singleton's entries

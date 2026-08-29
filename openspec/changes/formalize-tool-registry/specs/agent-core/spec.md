# agent-core — Delta Spec

## ADDED Requirements

### Requirement: Loop consumes the registry and flattens envelopes
The agent loop SHALL obtain the per-turn tool list from `registry.list(ctx)` and SHALL dispatch through the registry. Handler and skill results SHALL be `ToolResult` envelopes. The loop SHALL flatten each envelope into the string `content` of the provider-facing tool `Msg` (summary plus detail on success; `error.message` on failure) so existing provider adapters keep their current wire format.

#### Scenario: Provider still sees strings
- **WHEN** a turn's tool call completes
- **THEN** the `Msg` appended with `role: 'tool'` has string `content` derived from the envelope, and the transcript event stores the envelope

#### Scenario: Off-catalog names stay prose
- **WHEN** `parseToolCalls` is given a catalog `Set` from `registry.list(ctx)` and the model emits a name not in that set
- **THEN** that emission is left as prose and is not dispatched

### Requirement: Skill dispatch is a nested turn loop
When the dispatched name is a skill, the loop SHALL run the nested sub-run specified by the tool-registry capability (shared ledger and transcript, restricted tool subset, no snapshot/commit/archive) and SHALL continue the parent turn with that one envelope. The parent loop SHALL remain the only path that snapshots, commits, or archives.

#### Scenario: Inner turns do not commit
- **WHEN** a parent `do` run calls `generate_report` mid-loop
- **THEN** after the skill returns, the working tree has no extra commit attributable to the skill, and the parent loop is still in progress

#### Scenario: Nested finish cannot satisfy the parent
- **WHEN** a nested sub-run ends
- **THEN** the parent's `finishRequest` is unchanged from before the skill call, and commit still requires the parent to call `finish` with obligations clear

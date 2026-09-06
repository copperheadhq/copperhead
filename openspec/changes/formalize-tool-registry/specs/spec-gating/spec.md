# spec-gating — Delta Spec

## MODIFIED Requirements

### Requirement: Edit tools locked until proposal validates
The agent SHALL NOT have `edit_file` or `write_file` in its tool list until an OpenSpec change proposal for the current request exists and `openspec validate --change <id>` passes. The lock is structural (tools absent from `registry.list(ctx)`), not prompt-based and not a dispatch-time refusal of a still-listed tool. Any skill whose declared `tools` include `edit_file`, `write_file`, or another entry that is itself gated on the unlock SHALL likewise be absent from `registry.list(ctx)` until that validation passes.

#### Scenario: Pre-validation tool list
- **WHEN** a `do` run is in its plan step, before validation passes
- **THEN** the tool list sent to the provider contains no `edit_file` or `write_file`

#### Scenario: Unlock after validation
- **WHEN** `openspec validate --change <id>` exits 0
- **THEN** subsequent turns include the edit tools, and the transcript records the unlock event

#### Scenario: Absence is the invariant
- **WHEN** edits are locked
- **THEN** `registry.list(ctx).map(e => e.name)` does not contain `edit_file` or `write_file`, even if a subsequent `dispatchTool(ctx, 'edit_file', …)` would also return `error.kind` `unavailable`

#### Scenario: Skill cannot smuggle an edit tool
- **WHEN** edits are locked and a skill lists `edit_file` in its `tools`
- **THEN** that skill is absent from the tool list sent to the provider

## ADDED Requirements

### Requirement: Gating-sync absence assertion is not replaced by envelope kind
The structural spec-gating test SHALL assert absence from `registry.list(ctx)` (or the equivalent catalog the provider receives). An assertion that `dispatchTool` returned `error.kind === 'unavailable'` MAY exist in addition, and MUST NOT be the sole proof that an edit tool was locked.

#### Scenario: Both assertions on a locked dispatch
- **WHEN** the gating-sync test runs with edits locked
- **THEN** it asserts `edit_file` is not in `list(ctx)` and, if it also dispatches `edit_file`, treats the `unavailable` envelope as a secondary check

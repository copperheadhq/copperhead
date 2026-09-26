# spec-gating — Delta Spec

## ADDED Requirements

### Requirement: Edit tools locked until proposal validates
The agent SHALL NOT have `edit_file` or `write_file` in its tool list until an OpenSpec change proposal for the current request exists and `openspec validate --change <id>` passes. The lock is structural (tools absent), not prompt-based.

#### Scenario: Pre-validation tool list
- **WHEN** a `do` run is in its plan step, before validation passes
- **THEN** the tool list sent to the provider contains no `edit_file` or `write_file`

#### Scenario: Unlock after validation
- **WHEN** `openspec validate --change <id>` exits 0
- **THEN** subsequent turns include the edit tools, and the transcript records the unlock event

#### Scenario: Approval invalidated by replacement or revalidation
- **WHEN** a validated proposal is replaced or validation starts again
- **THEN** edit tools are removed until validation and any interactive approval pass again; failure or declined approval leaves them locked and prevents successful completion

#### Scenario: Invalid change identifier
- **WHEN** a proposal uses a path or any identifier other than a kebab-case name
- **THEN** the tool rejects it before writing any proposal file

### Requirement: Change workflow lifecycle
Each `do` run SHALL create `openspec/changes/<id>/` (proposal, spec deltas, tasks) as its plan step, and the same code path that makes the ERC/DRC-clean commit SHALL run `openspec archive <id>`. In autonomous mode the proposal is auto-approved with an `AUTO` marker; in `--interactive` mode a human y/n gate sits between validation and edit unlock.

#### Scenario: Paper trail on success
- **WHEN** a `do` run commits successfully
- **THEN** the change record has been archived and its deltas merged into `openspec/specs/`, linking request → spec change → file edits → verification result

#### Scenario: Interactive gate
- **WHEN** `do --interactive` reaches a validated proposal
- **THEN** the run pauses for y/n approval before any edit tool becomes available

### Requirement: OpenSpec as subprocess
copperhead SHALL drive the OpenSpec CLI as a subprocess (never user-triggered): `openspec init` once at `init`/`create` start if `openspec/` is absent, and `openspec validate` as part of every `check` run.

#### Scenario: First-run scaffold
- **WHEN** `copperhead init` runs in a repo without `openspec/`
- **THEN** `openspec init` is executed once and `openspec/` exists afterward

### Requirement: Constraint registry with same-turn dual write
The agent SHALL maintain `.copperhead/constraints.json` (value bounds, source, `affects[]`); whenever a constraint is stated, assumed, or discovered, the doc entry and registry entry MUST be written in the same tool turn. The registry SHALL be loaded into every run's system prompt, and `check` SHALL validate mechanically checkable constraints (leakage sums, forbidden pins).

#### Scenario: Dual write
- **WHEN** the agent records a new constraint in a doc during a run
- **THEN** the same turn writes the matching entry (with source and affects) to `.copperhead/constraints.json`

#### Scenario: Mechanical validation
- **WHEN** `check` runs and a design uses a pin listed as forbidden in the registry
- **THEN** `check` exits non-zero naming the constraint and its source

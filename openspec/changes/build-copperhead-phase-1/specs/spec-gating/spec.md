# spec-gating — Delta Spec

## ADDED Requirements

### Requirement: Edit tools locked until proposal validates
The agent SHALL NOT have `edit_file` or `write_file` in its tool list until an OpenSpec change proposal for the current request exists and `openspec validate --change <id>` passes. The lock is structural (tools absent), not prompt-based.

#### Scenario: Author a complete proposal while edits are locked
- **WHEN** the agent calls `propose_change` in an initialized OpenSpec workspace
- **THEN** it supplies a nonempty `spec_deltas` list of capability names and requirement/scenario markdown, and the tool writes only proposal.md, tasks.md and the named capability spec.md files beneath that change
- **AND** edit tools remain absent until actual OpenSpec validation succeeds

#### Scenario: Invalid planning destination
- **WHEN** a change id or capability is not a single kebab-case name, capabilities are duplicated, or a destination or its parent is a symlink
- **THEN** the proposal tool rejects the call before rewriting planning files and does not unlock edits

#### Scenario: Proposal revision invalidates earlier permission
- **WHEN** an agent revises or revalidates a previously approved proposal
- **THEN** the edit lock is restored before the operation, and a write failure, failed validation or declined human approval leaves edits locked

#### Scenario: Pre-validation tool list
- **WHEN** a `do` run is in its plan step, before validation passes
- **THEN** the tool list sent to the provider contains no `edit_file` or `write_file`

#### Scenario: Unlock after validation
- **WHEN** `openspec validate --change <id>` exits 0
- **THEN** subsequent turns include the edit tools, and the transcript records the unlock event

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

# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: Brief freshness in `check` JSON and exit status

The `copperhead check` and `verify` commands SHALL include a structured brief-freshness result in text and JSON output. Stale or unknown brief state SHALL make the default command exit non-zero. Legacy brief state SHALL be reported as a non-failing advisory. The check SHALL remain LLM-free and network-free.

#### Scenario: Stale brief in JSON mode

- **WHEN** `copperhead check --json` finds a brief hash mismatch
- **THEN** the JSON includes status `stale`, recorded and current hashes, and `ok: false`, and the process exits non-zero

#### Scenario: Unknown brief state in JSON mode

- **WHEN** `copperhead check --json` finds missing or untrackable reconciliation state for a repository with brief provenance
- **THEN** the JSON includes status `unknown`, a safe reason, and `ok: false`, and the process exits non-zero

#### Scenario: Legacy brief state in JSON mode

- **WHEN** `copperhead check --json` finds an origin without reconciliation state or a conventional brief without provenance
- **THEN** the JSON includes status `legacy` and `ok: true`, and the process exits successfully

### Requirement: Reconcile brief with sync

The CLI SHALL provide `copperhead sync --brief` to reconcile changed brief blocks through the existing gated agent loop. The CLI SHALL provide `copperhead sync --brief --dry-run` to display the comparison without edits or reconciliation-state changes.

#### Scenario: Brief reconciliation preview

- **WHEN** the user runs `copperhead sync --brief --dry-run`
- **THEN** the command displays the brief differences and does not call a provider or modify repository state

#### Scenario: Preview an external-origin legacy brief

- **WHEN** the user runs `copperhead sync --brief --dry-run` for an external origin without a reconciliation record
- **THEN** the comparison is reported unavailable and the command exits successfully without changing repository state

#### Scenario: Brief reconciliation run

- **WHEN** the user runs `copperhead sync --brief` with changed blocks
- **THEN** the existing gated run loop processes them and advances the reconciliation record only after all item decisions and gates pass

#### Scenario: Reconcile an edited brief before committing it

- **WHEN** the configured tracked brief is the only pre-existing dirty path
- **THEN** `sync --brief` may process it and commit the brief with its reconciliation record; any other dirty or untracked path causes an early refusal

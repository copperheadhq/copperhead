# brief-reconciliation — Delta Spec

## ADDED Requirements

### Requirement: Preserve immutable brief origin and track reconciliation separately

The system SHALL preserve the existing write-once `docs/BRIEF.sha256` origin record. It SHALL store the last successfully reconciled brief identity separately, including the repository-relative path, SHA-256, and Git blob identity. Declined changed requirements SHALL remain visible with their changed text and recorded rationale.

#### Scenario: Initial project creation records a baseline

- **WHEN** all create stages and the final check succeed for a tracked repository-local brief, either matching an in-repository immutable origin or copied into the repository for an external origin
- **THEN** the system records that brief as the last reconciled version without changing the origin hash

#### Scenario: Failed or incomplete work does not advance the baseline

- **WHEN** create or brief reconciliation refuses, fails verification, exhausts repair, or fails to commit
- **THEN** the prior reconciliation record remains unchanged and the normal snapshot rollback behavior applies

#### Scenario: Create rejects an external brief before work starts

- **WHEN** `create --brief` points to a file outside the target repository
- **THEN** create exits before starting a stage, calling a provider, or writing project files

#### Scenario: Demo copies its packaged brief before create

- **WHEN** `copperhead demo` or `scripts/demo-simple.sh` uses a packaged brief outside the demo repository
- **THEN** demo copies the brief into `<docsDir>/BRIEF.md`, refuses to overwrite different existing content, commits the local brief, and invokes create with that repository-local path

### Requirement: Check reports brief freshness

`copperhead check` SHALL compare the configured brief with its last-reconciled identity. Mismatches SHALL be stale. Corrupt or mismatched records and unavailable repository-local origins SHALL be unknown and fail. The legacy cases below SHALL be advisory. Brief checks SHALL be deterministic, LLM-free, and network-free. With no brief or origin, the result SHALL be not applicable.

#### Scenario: Brief matches last reconciled version

- **WHEN** the current brief hash equals the recorded reconciliation hash
- **THEN** check reports brief status `current` and does not fail because of brief freshness

#### Scenario: Brief changed after reconciliation

- **WHEN** the current brief hash differs from the last-reconciled hash
- **THEN** check reports `stale`, includes both hashes, and returns a failing result

#### Scenario: Matching legacy origin has no reconciliation record

- **WHEN** the current repository-local brief matches its origin provenance but no last-reconciled record exists
- **THEN** check reports `legacy`, returns a non-failing advisory result, and identifies `copperhead create --brief <origin path>` as the command to establish the baseline

#### Scenario: Legacy origin hash uses different line endings

- **WHEN** an unchanged in-repository brief has an origin hash computed from raw CRLF bytes while its Git blob uses LF bytes
- **THEN** check recognizes the origin as matching, reports `legacy` without failing, and successful create stores the normalized brief hash in the reconciliation record

#### Scenario: Legacy external origin has no reconciliation record

- **WHEN** origin provenance points to an external brief and no last-reconciled record exists
- **THEN** check reports `legacy` and returns a non-failing advisory result without attempting to read outside the repository

#### Scenario: Differing local copy of an external legacy origin

- **WHEN** an external origin has no reconciliation record and the repository-local conventional brief differs from the origin hash
- **THEN** check still reports non-failing `legacy` and identifies `copperhead create --brief <local brief path>` as the command to establish the tracked baseline

#### Scenario: Changed in-repository legacy origin

- **WHEN** the in-repository brief differs from its immutable origin beyond a line-ending representation change and no last-reconciled record exists
- **THEN** check reports `stale` and returns a failing result

#### Scenario: Conventional brief has no origin provenance

- **WHEN** the configured conventional brief exists without origin or reconciliation records
- **THEN** check reports `legacy` and returns a non-failing advisory result

#### Scenario: Reconciliation contains declined changes

- **WHEN** the current brief matches the last-reconciled version and one or more changes were explicitly declined
- **THEN** check reports current freshness and lists the declined items and rationales without describing them as implemented

#### Scenario: No brief provenance applies

- **WHEN** neither a configured brief nor an origin record exists
- **THEN** check reports `not-applicable` and does not fail because of brief freshness

### Requirement: Preview brief reconciliation without mutation

`copperhead sync --brief --dry-run` SHALL display a deterministic comparison between the current brief and the last-reconciled brief. For legacy state, it MAY compare with the immutable origin only when the exact origin text is recovered from local Git history and its SHA-256 matches the origin record. It SHALL not call a provider, modify project files, or advance reconciliation state.

#### Scenario: Preview changed brief

- **WHEN** the current brief differs from a recoverable recorded version and the user requests a dry run
- **THEN** the command displays each changed block and leaves the repository and reconciliation record unchanged

#### Scenario: Legacy origin cannot be recovered

- **WHEN** the legacy origin text cannot be recovered and verified from local Git history
- **THEN** the command reports that comparison is unavailable and leaves the record unchanged

#### Scenario: External-origin legacy preview is unavailable

- **WHEN** `sync --brief --dry-run` is run for an external origin without a reconciliation record
- **THEN** it reports the comparison as unavailable, exits successfully, and leaves the repository unchanged

### Requirement: Reconcile each changed brief item through gated tools

`sync --brief` SHALL reconcile changed brief blocks through the spec-gated agent loop. Each block SHALL receive one applied or declined decision with a non-empty rationale before finish. Existing verification, repair, sync-obligation, and rollback gates SHALL apply. The brief identity must match at commit. The brief and reconciliation record SHALL commit together after all gates pass; failures preserve prior state. Other dirty or untracked paths SHALL be refused before the run.

#### Scenario: Every changed block has an explicit decision

- **WHEN** the agent has recorded one unambiguous decision for every changed block and all existing gates pass
- **THEN** the run may finish and commit the decisions and new reconciliation identity atomically

#### Scenario: A changed block has no valid decision

- **WHEN** the agent attempts to finish with any changed block undecided, conflicting, or lacking a rationale
- **THEN** finish is rejected with the unresolved block identifiers and the reconciliation identity is not advanced

#### Scenario: Reconciliation source changes during the run

- **WHEN** the brief hash differs from the identity captured at run start before commit
- **THEN** the run is rejected and the reconciliation identity is not advanced

#### Scenario: The only pre-existing change is the tracked brief

- **WHEN** the configured, tracked brief is modified in the working tree and no other path is dirty or untracked
- **THEN** `sync --brief` reconciles that exact brief version and commits it with the new reconciliation record after all existing gates pass

#### Scenario: Another path is dirty before reconciliation

- **WHEN** any path other than the configured brief is dirty or untracked before `sync --brief`
- **THEN** the command refuses before starting the agent run and leaves all changes untouched

#### Scenario: No changed blocks exist for an unknown legacy baseline

- **WHEN** a legacy origin matches the current brief but there is no reconciled record
- **THEN** `sync --brief` does not infer completion and instructs the user to complete `create` to establish the initial baseline

#### Scenario: Prior comparison content is unavailable

- **WHEN** the recorded Git blob cannot be read for a requested comparison
- **THEN** the command reports unknown and refuses to advance the record

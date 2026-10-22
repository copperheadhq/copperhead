# brief-reconciliation — Delta Spec

## ADDED Requirements

### Requirement: Preserve immutable brief origin and track reconciliation separately

The system SHALL preserve the existing write-once `docs/BRIEF.sha256` origin record. It SHALL store the last successfully reconciled brief identity separately, including the repository-relative path, SHA-256, and Git blob identity. Declined changed requirements SHALL remain visible with their changed text and recorded rationale.

#### Scenario: Initial project creation records a baseline

- **WHEN** all create stages and the final check succeed for a tracked repository-local brief that matches the immutable origin
- **THEN** the system records that brief as the last reconciled version without changing the origin hash

#### Scenario: Failed or incomplete work does not advance the baseline

- **WHEN** create or brief reconciliation refuses, fails verification, exhausts repair, or fails to commit
- **THEN** the prior reconciliation record remains unchanged and the normal snapshot rollback behavior applies

#### Scenario: Create rejects an external brief before work starts

- **WHEN** `create --brief` points to a file outside the target repository
- **THEN** create exits before starting a stage or provider call and writes no project files or brief provenance

### Requirement: Check reports brief freshness

`copperhead check` SHALL compare the configured current brief with its last reconciled identity. A known mismatch SHALL be reported as stale. Missing, corrupt, or untrackable reconciliation state for a project with brief provenance SHALL be reported as unknown. Stale and unknown status SHALL be included in JSON and make the default check result fail. Brief checks SHALL be deterministic, LLM-free, and network-free. A project with no brief and no origin record SHALL report not applicable.

#### Scenario: Brief matches last reconciled version

- **WHEN** the current brief hash equals the recorded reconciliation hash
- **THEN** check reports brief status `current` and does not fail because of brief freshness

#### Scenario: Brief changed after reconciliation

- **WHEN** the current brief hash differs from the last-reconciled hash
- **THEN** check reports `stale`, includes both hashes, and returns a failing result

#### Scenario: Legacy repository has only an origin record

- **WHEN** origin provenance exists but no last-reconciled record exists
- **THEN** check reports `unknown` and returns a failing result, even if the current hash matches the origin

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

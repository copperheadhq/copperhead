# safety-rails — Delta Spec

## ADDED Requirements

### Requirement: Path sandboxing
All file tools SHALL resolve paths relative to the repo root and reject any path escaping it; no network tools exist in Phase 1.

#### Scenario: Traversal rejected (AC-4.2)
- **WHEN** a tool call targets a path outside the repo root (e.g. `../../etc/hosts`)
- **THEN** the call is rejected with an error and no file outside the repo is read or written

### Requirement: Git-state preconditions and rollback
`do` and `repl` SHALL refuse to start on a dirty git tree unless `--allow-dirty` is passed, whose snapshot pairs a `git stash create` object for tracked changes with a tree object for the untracked-but-not-ignored files that `git stash create` cannot capture; on unrecoverable failure the working tree SHALL be restored to the pre-run snapshot, tracked and untracked alike.

#### Scenario: Dirty tree refusal (AC-3.8)
- **WHEN** the repo has uncommitted changes and `do` or `repl` runs without `--allow-dirty`
- **THEN** it refuses to start and suggests `--allow-dirty`

#### Scenario: Untracked work survives a rollback (AC-3.8)
- **WHEN** a run started with `--allow-dirty` fails unrecoverably and the tree held untracked, non-ignored files before the run
- **THEN** the rollback restores those files along with the tracked modifications, and gitignored paths are neither captured nor disturbed

#### Scenario: Unsnapshottable untracked file refused
- **WHEN** a run starts with `--allow-dirty` and an untracked, non-ignored file exists that copperhead cannot read
- **THEN** it refuses to start, names the file, and explains that the rollback would delete it with nothing to restore it from

#### Scenario: Snapshot restore
- **WHEN** a run fails unrecoverably
- **THEN** if no external changes were made, `git status` and file bytes match the pre-run state; otherwise rollback refuses and preserves the tree for manual review

### Requirement: Exclusive per-working-tree run lock
Every mutating `do`, `create`, `init`, `draft schematic`, or sync-resolve run SHALL acquire an exclusive lock for its working tree before repository preflight or startup writes and hold it through completion, commit, or rollback. CLI and MCP entry points SHALL use the same lock. The lock coordinates participating commands. Run ownership checks SHALL also protect changes made by programs that do not take the lock.

#### Scenario: Concurrent run is refused
- **WHEN** a second `do`, `create`, `init`, `draft schematic`, or sync-resolve starts while a run holds the working-tree lock
- **THEN** it refuses before preflight or mutation and names the active process and start time

#### Scenario: Standalone draft respects an active run
- **WHEN** `copperhead draft schematic` runs while another process owns the working-tree lock
- **THEN** it refuses with the owner PID and start time before writing the schematic, project, or symbol library table

### Requirement: Recover abandoned local run and cleanup locks
An exited run or cleanup owner with verifiable local identity SHALL not permanently block the working tree. Recovery SHALL preserve any newer live owner.

#### Scenario: Stale run lock is reclaimed
- **WHEN** a valid local lock owner process has exited
- **THEN** the next run safely reclaims the stale lock and proceeds

#### Scenario: Cleaner crashed during recovery
- **WHEN** a valid local run lock and its cleanup lock both belong to exited owners
- **THEN** the next run safely recovers both, and simultaneous recovery attempts cannot remove a newly acquired live lock

### Requirement: Publish complete lock metadata atomically
The lock SHALL publish complete metadata atomically and record the owner PID, lock start time, operation, hostname, PID namespace, and process start identity where available.

#### Scenario: Acquisition interrupted before publication
- **WHEN** a process exits while writing its temporary metadata file
- **THEN** no incomplete lock is visible and the next run can acquire the lock

### Requirement: Verify lock ownership before reclamation
Automatic reclamation SHALL require matching hostname and PID namespace. Process start identity SHALL be compared where available. Unreadable metadata or unverifiable ownership SHALL refuse reclamation and name the lock for manual inspection. On platforms without start identity, a reused live PID SHALL require manual inspection.

#### Scenario: Owner belongs to another host or PID namespace
- **WHEN** the recorded hostname or PID namespace differs from the current process
- **THEN** the command refuses, leaves the lock intact, and explains how to inspect ownership manually

#### Scenario: PID reused after exit or reboot
- **WHEN** a lock names a live PID whose process start identity differs from its recorded identity on a platform exposing that identity
- **THEN** the stale lock is reclaimed rather than attributed to the unrelated process

### Requirement: Commit only run-owned bytes
A run SHALL commit only paths whose recorded bytes belong to that run, SHALL preserve unrelated staged and unstaged changes, and SHALL refuse to attribute pre-existing changes to itself. A changed owned file, HEAD, checked-out branch, or index SHALL refuse commit. Commit publication SHALL compare the expected old HEAD atomically. Commit hooks and configured signing SHALL remain enabled.

#### Scenario: An unrelated writer edits another path
- **WHEN** an external writer creates or edits a file the run did not write
- **THEN** the run's commit excludes that file and leaves its contents and staging state intact

#### Scenario: An external writer edits a run-owned file
- **WHEN** an owned file no longer matches the run's last recorded bytes or mode
- **THEN** further writes and commit refuse without overwriting those external changes

#### Scenario: Create resumes pre-existing uncommitted work
- **WHEN** an already-complete stage has uncommitted files that the current run cannot attribute to itself
- **THEN** create leaves those files uncommitted and reports that manual review is required

### Requirement: Guard rollback against external changes
Rollback SHALL compare the tracked and untracked project state, HEAD, branch, and index against the run's expected state. External changes SHALL stop rollback and create retries, preserve files and commits, and produce an `external-change` summary. A normal rollback SHALL restore only run-owned paths to their checkpoint bytes without resetting HEAD or cleaning unrelated files. Failed-run preservation SHALL not change the real index.

#### Scenario: An external file arrives or changes during a failing run
- **WHEN** rollback detects an external addition, deletion, content edit, or mode change
- **THEN** it refuses and leaves both the run's and external writer's changes available for manual inspection

#### Scenario: Another writer commits or stages work
- **WHEN** HEAD, branch, or index differs from the run's expected state
- **THEN** commit and rollback refuse without discarding that commit or staged work

#### Scenario: No external changes during failure
- **WHEN** a failed run's tree still matches its recorded state
- **THEN** rollback restores its snapshot, including pre-existing dirty files, and the failed draft remains recoverable

### Requirement: Secret hygiene
API keys SHALL exist only in environment variables; `.env` and `.copperhead/runs/` SHALL be in `.gitignore` from the first commit; transcripts SHALL redact anything matching `sk-[A-Za-z0-9_-]+` at write time.

#### Scenario: No keys anywhere (AC-4.1)
- **WHEN** the full test suite has run
- **THEN** no file in the repo tree, transcripts, or any commit matches `sk-[A-Za-z0-9_-]{20,}`

#### Scenario: gitignore from first commit (AC-4.3)
- **WHEN** the repo's first commit is inspected
- **THEN** `.gitignore` already includes `.env` and `.copperhead/runs/`

### Requirement: No invented part numbers
The agent SHALL never present an MPN as verified: any newly introduced part MUST carry a datasheet-verifiable justification in BOM.md and be flagged `UNVERIFIED` for human review.

#### Scenario: New part flagged
- **WHEN** a run adds a part not previously in the BOM
- **THEN** its BOM.md row includes an `UNVERIFIED` flag and a one-line justification

### Requirement: Honest completion claims
The agent SHALL never claim a design is fab-ready beyond "ERC/DRC clean"; refusals of budget-violating requests SHALL cite the documented budget rather than silently complying.

#### Scenario: No overclaim
- **WHEN** a run finishes with all checks green
- **THEN** the report states ERC/DRC-clean status without asserting fab-readiness or engineer sign-off

### Requirement: Run transcripts
Every `do`/`create` run SHALL write a transcript (audit trail) under `.copperhead/runs/`, and failure output SHALL include the transcript path.

#### Scenario: Transcript on failure
- **WHEN** a run exits non-zero
- **THEN** the transcript file exists under `.copperhead/runs/` and its path was printed

### Requirement: Human-readable run summary
Every run SHALL write a `summary.md` beside its JSONL transcript containing the request, OpenSpec change id, plan, files touched, ERC/DRC results, decisions made, and token usage — subject to the same secret redaction as the transcript.

#### Scenario: Summary written on completion
- **WHEN** a run finishes (success or failure)
- **THEN** `.copperhead/runs/<ts>/summary.md` exists and states the request, verification results, and files touched in prose a human can read without tooling

#### Scenario: Summary is redacted
- **WHEN** the summary is written
- **THEN** it contains no string matching `sk-[A-Za-z0-9_-]{20,}`

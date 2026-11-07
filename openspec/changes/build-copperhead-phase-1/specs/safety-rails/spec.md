# safety-rails — Delta Spec

## ADDED Requirements

### Requirement: Path sandboxing
All file tools SHALL resolve paths relative to the repo root and reject any path escaping it; no network tools exist in Phase 1.

#### Scenario: Traversal rejected (AC-4.2)
- **WHEN** a tool call targets a path outside the repo root (e.g. `../../etc/hosts`)
- **THEN** the call is rejected with an error and no file outside the repo is read or written

### Requirement: Bounded search evaluation
The `search` tool SHALL evaluate its pattern on a worker thread under a hard time budget (default 2,000 ms) with a 1,000-character pattern cap; a pattern that exceeds the budget or the cap, or that does not compile, SHALL fail closed with a typed error that names the reason, SHALL never be retried, and SHALL never block the agent or an MCP host, because the exceeding worker thread is terminated.

#### Scenario: Bounded search (AC-4.4)
- **WHEN** a `search` pattern evaluation exceeds the 2,000 ms budget, the pattern is over 1,000 characters, or the pattern is an invalid regex
- **THEN** the call fails closed with a typed error naming the reason, the exceeding worker thread is terminated, the call is never retried, and ordinary patterns keep matching exactly as before

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
- **THEN** `git status` is clean and all files are byte-identical to the pre-run state

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

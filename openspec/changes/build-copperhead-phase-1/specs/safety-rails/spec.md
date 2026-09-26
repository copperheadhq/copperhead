# safety-rails — Delta Spec

## ADDED Requirements

### Requirement: Path sandboxing
All file tools SHALL resolve paths relative to the repo root and reject any path escaping it. Paths through symbolic links below the repo root SHALL be refused, including links to in-repo files that could hide a KiCad extension from verification gates; the repo root itself MAY be reached through a symbolic link. Search SHALL skip symbolic links and non-regular files; no network tools exist in Phase 1.

#### Scenario: Traversal rejected (AC-4.2)
- **WHEN** a tool call targets a path outside the repo root (e.g. `../../etc/hosts`)
- **THEN** the call is rejected with an error and no file outside the repo is read or written

#### Scenario: Symbolic-link aliases rejected (AC-4.2)
- **WHEN** a read, edit, or write targets a path through a symbolic link below the repo root, including a dangling link or an in-repo alias
- **THEN** the call is rejected without reading or changing its target, and search does not follow the link

#### Scenario: Repo root may be a symbolic link
- **WHEN** the repo root is reached through a symbolic link and a tool targets a regular file beneath it
- **THEN** the tool works normally without treating the root alias as an escape

#### Scenario: Configured paths are sandboxed
- **WHEN** `.copperhead/config.json` configures `schematic`, `board`, or `docs` with an absolute, escaping, or symbolic-link path
- **THEN** loading configuration refuses the path before a command or tool can use it; the default docs path follows the same checks, and neither a symbolic-linked `.copperhead` directory nor a symbolic-linked config file is read

#### Scenario: Concurrent new-file creation
- **WHEN** two `write_file` calls target the same initially absent file
- **THEN** at most one succeeds and the other cannot overwrite the created file

### Requirement: Git-state preconditions and rollback
`do` and `repl` SHALL refuse to start on a dirty git tree unless `--allow-dirty` is passed, whose snapshot pairs a `git stash create` object for tracked changes with a tree object for the untracked-but-not-ignored files that `git stash create` cannot capture; on unrecoverable failure the working tree SHALL be restored to the pre-run snapshot, tracked and untracked alike, preserving the staged/unstaged split, literal filenames, and dangling untracked symbolic links.

#### Scenario: Dirty tree refusal (AC-3.8)
- **WHEN** the repo has uncommitted changes and `do` or `repl` runs without `--allow-dirty`
- **THEN** it refuses to start and suggests `--allow-dirty`

#### Scenario: Untracked work survives a rollback (AC-3.8)
- **WHEN** a run started with `--allow-dirty` fails unrecoverably and the tree held untracked, non-ignored files before the run
- **THEN** the rollback restores those files along with the tracked modifications, and gitignored paths are neither captured nor disturbed

#### Scenario: Staged and unstaged changes survive independently (AC-3.8)
- **WHEN** a tracked file has both staged and unstaged edits before a failed run
- **THEN** rollback restores the original index version and working-tree version separately

#### Scenario: Literal filenames and dangling links survive (AC-3.8)
- **WHEN** untracked work includes filenames with leading whitespace, newlines, or non-ASCII characters, or a symbolic link whose target does not exist
- **THEN** snapshot and rollback preserve the filenames, file contents, and symbolic-link target text exactly

#### Scenario: Originally ignored files survive changed ignore rules (AC-3.8)
- **WHEN** pre-run ignored files are protected by uncommitted ignore rules and a failed run changes those rules or stages the files
- **THEN** rollback preserves those files without capturing their contents in the snapshot, including when the original ignore rules came from an untracked nested `.gitignore`

#### Scenario: Commits and recovery stashes exclude originally ignored data
- **WHEN** a run has removed ignore rules or staged originally ignored files
- **THEN** its commit or recovery stash excludes those files while preserving the run's other tracked and untracked work, and rollback leaves the original ignored files on disk

#### Scenario: Project inside a larger Git repository
- **WHEN** the selected project directory is below the Git root
- **THEN** staging uses project-relative literal paths, rollback restores staged and unstaged work, and original ignored files under that project remain protected

#### Scenario: Metadata and audit paths cannot follow symlinks
- **WHEN** a proposal, decision, constraint, changelog, prompt document, or transcript path contains a symlink below the project root
- **THEN** the operation fails before reading or writing the symlink target
- **AND** a symlinked `.gitignore` blocks staging before any private files can be added

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

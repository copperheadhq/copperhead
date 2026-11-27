# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: Command set
The `copperhead` CLI SHALL provide the commands `create --brief <file>`, `init [--path <dir>]`, `do "<change request>"`, `check`, and `sync`, plus the global flags `--repo <path>`, `--dry-run`, and `--json`.

#### Scenario: Help lists all Phase 1 commands
- **WHEN** `copperhead --help` is run
- **THEN** the output lists `create`, `init`, `do`, `check`, and `sync` with one-line descriptions and the global flags

#### Scenario: Unknown command
- **WHEN** an unrecognized command is invoked
- **THEN** the CLI exits non-zero with a usage message and no stack trace

### Requirement: `check` is deterministic and LLM-free
`copperhead check` SHALL run ERC, DRC, and the doc-drift check, exit non-zero if any violation exists, and make zero LLM/network calls, completing in under 60 seconds on the test fixture. `copperhead verify` SHALL be an alias with identical behavior.

#### Scenario: verify alias
- **WHEN** `copperhead verify` is run
- **THEN** it behaves identically to `copperhead check`, and `--help` lists `verify` as an alias of `check`

#### Scenario: Clean fixture passes (AC-2.1, AC-2.5)
- **WHEN** `check` runs on a clean fixture repo
- **THEN** it exits 0, prints ERC ✓ DRC ✓ drift ✓, makes no network calls to any api.* host, and finishes in < 60 s

#### Scenario: Broken schematic fails with location (AC-2.2)
- **WHEN** `check` runs on a schematic with an unconnected pin
- **THEN** it exits non-zero and prints the violation with its sheet and location

#### Scenario: Configured schematic absent (AC-2.6)
- **WHEN** `check` runs on a repo whose configured `schematic` names a file that is not on disk
- **THEN** it exits non-zero and names the configured path in every skip reason it prints, rather than exiting 0 with a generic "no schematic configured" message

### Requirement: JSON output mode
With `--json`, commands SHALL emit machine-readable results with stable keys.

#### Scenario: check --json (AC-2.4)
- **WHEN** `copperhead check --json` runs
- **THEN** stdout is parseable JSON whose keys (erc, drc, drift, violations) are stable across runs

### Requirement: Full-state consistency verification and resolution
`copperhead sync` SHALL verify the entire design state for inconsistencies — doc tables vs schematic, constraints.json vs doc/spec mentions in both directions, PINOUT.md vs pins.h, DECISIONS/CHANGELOG coverage, `openspec validate` — and resolve detected drift via a spec-gated agent run under a truth-precedence rule: KiCad files are ground truth for as-built facts, openspec specs and SPEC.md budgets are ground truth for requirements. An inconsistency that implies a requirement violation SHALL be flagged with both sides and the governing spec, never silently resolved, with a non-zero exit.

#### Scenario: Resolve doc drift (AC-7.1)
- **WHEN** BOM.md disagrees with the schematic and `sync` runs
- **THEN** the doc is updated to match the as-built schematic, DECISIONS.md and CHANGELOG.md gain entries, exactly one commit is made, `sync` exits 0, and an immediate `check` run is clean

#### Scenario: Repair dual-write gaps (AC-7.2)
- **WHEN** a constraint exists in a doc but not in `constraints.json` (or vice versa)
- **THEN** `sync` adds the missing side with the correct source and affects fields

#### Scenario: Requirement violation is flagged, not rewritten (AC-7.3)
- **WHEN** the as-built design violates a documented requirement (e.g. leakage exceeds the sleep-current budget)
- **THEN** `sync` rewrites neither side, reports both sides and the governing spec/budget, and exits non-zero

#### Scenario: Dry-run report (AC-7.4)
- **WHEN** `sync --dry-run` runs
- **THEN** every detected inconsistency is printed with doc, claim, actual, and proposed resolution, and `git status` is unchanged

#### Scenario: Clean and idempotent (AC-7.5)
- **WHEN** `sync` runs on a consistent repo, or runs twice in a row
- **THEN** it exits 0 reporting no inconsistencies, and the second consecutive run makes no edits and no commit

### Requirement: Dry-run mode
With `--dry-run`, `do` SHALL print the proposed diff and write no files.

#### Scenario: Dry run writes nothing (AC-3.9)
- **WHEN** `do "<request>" --dry-run` completes
- **THEN** the proposed diff is printed and `git status` shows no changes

### Requirement: Model selection precedence
The active provider/model SHALL be resolved as: `--model` flag, then `COPPERHEAD_MODEL` env var, then `.copperhead/config.json`, then the default for whichever API key is present.

#### Scenario: Flag overrides config
- **WHEN** config.json says `"model": "gpt-5"` and the user runs `do --model claude`
- **THEN** the Anthropic provider is used for that run

# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `diff` command summarizes electrical changes deterministically

The CLI SHALL provide `copperhead diff [--base <rev>]` to summarize electrical schematic changes since a git revision without making LLM or network calls, and SHALL support `--json` output matching `runDiff`.

#### Scenario: Clean post-commit working tree diffs against HEAD~1 by default

- **WHEN** `copperhead diff` runs with no `--base` flag on a repo whose working-tree schematic matches `HEAD` and `HEAD~1` exists
- **THEN** it compares `HEAD` against `HEAD~1` and prints the electrical change summary

#### Scenario: Exit code 0 when electrical changes are present and 1 on error

- **WHEN** `copperhead diff` completes successfully (whether `hasChanges` is `true` or `false`)
- **THEN** the CLI exits with status `0`
- **AND WHEN** `copperhead diff` fails due to an unresolvable `--base` revision, missing schematic, or out-of-sandbox sub-sheet path
- **THEN** the CLI exits with status `1`

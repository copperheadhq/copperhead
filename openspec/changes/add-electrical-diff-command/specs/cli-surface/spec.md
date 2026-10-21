# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `diff` command summarizes electrical changes deterministically

The CLI SHALL provide `copperhead diff [--base <rev>]` to summarize electrical schematic changes since a git revision without making LLM or network calls, and SHALL support `--json` output matching `runDiff`.

#### Scenario: Clean post-commit working tree diffs against HEAD~1 by default

- **WHEN** `copperhead diff` runs with no `--base` flag on a repo whose working-tree schematic matches `HEAD` and `HEAD~1` exists
- **THEN** it compares `HEAD` against `HEAD~1` and prints the electrical change summary

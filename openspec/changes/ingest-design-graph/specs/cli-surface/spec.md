# cli-surface: Delta Spec

## ADDED Requirements

### Requirement: `ingest` command
The CLI SHALL provide `copperhead ingest`, which parses the configured schematic into `.copperhead/design-graph.json`. It SHALL be LLM-free and network-free, SHALL print the graph instead of a summary under the global `--json` flag, and SHALL exit 1 with a message and no stack trace when no schematic is configured or extraction fails, and 0 otherwise.

#### Scenario: Graph written
- **WHEN** `copperhead ingest` runs in an initialised repo
- **THEN** `.copperhead/design-graph.json` is written, a summary of the part and net counts is printed, and it exits 0

#### Scenario: JSON output
- **WHEN** `copperhead --json ingest` runs
- **THEN** standard output is the graph as JSON, carrying a `version`

#### Scenario: No schematic configured
- **WHEN** `copperhead ingest` runs where no schematic is configured
- **THEN** it exits 1 naming `copperhead init` and writes no graph

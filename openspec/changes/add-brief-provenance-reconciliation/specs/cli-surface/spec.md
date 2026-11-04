# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: Brief provenance check and `sync --brief` acknowledgement

`copperhead check` SHALL verify `<docs>/BRIEF.sha256` when present, fail on divergence (`AC-2.6`), and include `brief: BriefProvenanceStatus | null` in `check --json`. Plain `copperhead sync` SHALL treat brief divergence as a requirement violation and exit 2 (`AC-7.6`). `copperhead sync --brief` SHALL preview under `--dry-run`, refuse when non-brief requirement violations exist or when resolvable doc drift exists without `--model`, and otherwise acknowledge the current brief in `BRIEF.sha256` (preserving `origin_sha256`) while stating that the design was not re-verified.

#### Scenario: `sync --brief --dry-run` previews acknowledgement without writing

- **WHEN** the brief file has been edited and `copperhead sync --brief --dry-run` runs on an otherwise clean repo
- **THEN** the CLI exits 0, reports the recorded and current brief hashes, and leaves `BRIEF.sha256` unchanged

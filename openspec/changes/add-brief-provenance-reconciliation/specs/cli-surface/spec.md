# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: Brief provenance check and `sync --brief` reconciliation

`copperhead check` SHALL verify `<docs>/BRIEF.sha256` when present and include `brief: BriefProvenanceStatus | null` as a stable key in `check --json`. `copperhead sync --brief` SHALL run `syncVerify` first, preview the reconciliation under `--dry-run`, refuse when requirement violations or unresolved non-brief drift exist without a model, and update `BRIEF.sha256` while preserving `origin_sha256`.

#### Scenario: `sync --brief --dry-run` previews reconciliation without writing

- **WHEN** the brief file has been edited and `copperhead sync --brief --dry-run` runs
- **THEN** the CLI reports the recorded and current brief hashes and leaves `BRIEF.sha256` unchanged

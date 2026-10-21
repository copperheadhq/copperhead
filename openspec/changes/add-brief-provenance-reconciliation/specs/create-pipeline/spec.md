# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Write-once brief provenance with in-repo brief snapshot

`writeBriefHash` SHALL create `<docs>/BRIEF.sha256` with exclusive-create semantics (`wx`) after `spec-seed` so future `create` runs never overwrite it. When the brief path is external to the repository, `writeBriefHash` SHALL also snapshot the brief text to `<docs>/BRIEF.md` (using `wx` so an existing file is not overwritten).

#### Scenario: External brief is snapshotted into docs/BRIEF.md

- **WHEN** `copperhead create --brief /tmp/outside-brief.md` completes `spec-seed`
- **THEN** `<docs>/BRIEF.sha256` records `brief: external:outside-brief.md` and `<docs>/BRIEF.md` contains the brief text inside the repository

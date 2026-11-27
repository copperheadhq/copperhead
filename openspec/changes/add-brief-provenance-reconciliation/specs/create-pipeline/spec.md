# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Write-once brief provenance with in-repo brief snapshot

`writeBriefHash` SHALL create `<docs>/BRIEF.sha256` with exclusive-create semantics (`wx`) after `spec-seed`. When the brief path is external to the repository, `writeBriefHash` SHALL snapshot the brief text to `<docs>/BRIEF.md` (`wx`) and record `<docs>/BRIEF.md` in `BRIEF.sha256`.

#### Scenario: External brief is snapshotted into docs/BRIEF.md

- **WHEN** `copperhead create --brief /tmp/outside-brief.md` completes `spec-seed`
- **THEN** `<docs>/BRIEF.md` contains the brief text inside the repository and `checkBriefProvenance` returns `ok: true`

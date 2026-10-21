# docs-memory — Delta Spec

## ADDED Requirements

### Requirement: Sandboxed brief provenance verification

`checkBriefProvenance` SHALL resolve brief paths strictly within the repository via `resolveInRepo`, compare SHA-256 digests case-insensitively, and fail when the referenced brief file is missing or escapes the repository.

#### Scenario: Path traversal in BRIEF.sha256 is rejected

- **WHEN** `<docs>/BRIEF.sha256` contains `brief: ../../../etc/passwd`
- **THEN** `checkBriefProvenance` returns `ok: false` with `current: "outside-repo"` without reading the external file

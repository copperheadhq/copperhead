# constraint-memory — Delta Spec

## ADDED Requirements

### Requirement: Offline verification and preservation of constraint evidence

`copperhead check` SHALL validate every `.copperhead/constraints.json` entry carrying `evidence` offline against cached files under `.copperhead/datasheets/` or `docs/datasheets/`, and `record_constraint` SHALL accept and preserve `evidence` across re-records.

#### Scenario: Cached datasheet quote and hyphenated range satisfy numeric bound

- **WHEN** a constraint specifies `max: 3.6` with `evidence` pointing to a cached file whose quote reads `VDD range 1.8-3.6 V.`
- **THEN** `verifyConstraintEvidence` reports zero violations

#### Scenario: Missing PDF sidecar or symlink escaping cache fails verification

- **WHEN** `evidence.path` targets a `.pdf` lacking `<path>.txt` or a symlink resolving outside the allowed cache directories
- **THEN** `verifyConstraintEvidence` reports a constraint violation without reading outside the cache

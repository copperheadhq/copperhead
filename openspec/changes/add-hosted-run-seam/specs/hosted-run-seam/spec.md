# hosted-run-seam — Delta Spec

## ADDED Requirements

### Requirement: Artifact classification is derived from version control

Every output a run produces SHALL be classified by whether the run commits it, not by an enumerated list.

An output the run commits survives in the repository after the workspace is destroyed, so the platform SHALL store a reference to it (path plus the commit the writeback produced) and SHALL NOT copy its bytes. An output excluded by `.gitignore` does not survive, so the platform SHALL store its bytes.

Deriving the rule rather than fixing a list means a producer added later classifies itself, and the classification cannot go stale: if a directory's ignore status changes, the classification follows.

Under this rule, with the current producers and the board template's `.gitignore`:

| Producer | Written to | Classification |
| --- | --- | --- |
| `exportFab` (gerbers, drill, DXF, STEP) | `outputs/` | reference |
| `export bom` | `outputs/<supplier>-bom.csv` | reference |
| `exportSvg` | `.copperhead/renders/` | reference |
| `Transcript` (JSONL, `summary.md`) | `.copperhead/runs/<ts>/` | stored |
| `create` report (`REPORT.md`, `report.json`) | `.copperhead/runs/` | stored |

#### Scenario: A committed output needs no copy

- **WHEN** a run writes gerbers to `outputs/` and the writeback commits them
- **THEN** the artifact record holds the repository path and the commit, and no bytes are copied to storage

#### Scenario: An ignored output must be stored

- **WHEN** a run writes a transcript under `.copperhead/runs/`, which `.gitignore` excludes
- **THEN** the artifact record holds a stored-object location, because the file does not survive the workspace

### Requirement: The `.copperhead/` layout is a stated contract

The on-disk layout of `.copperhead/` SHALL be documented as a contract naming which entries are runs and which are not.

This is load-bearing rather than descriptive. `src/agent/runmeta.ts` derives `priorRuns` by listing `.copperhead/runs` and filtering out the current run id, so it treats every entry there as a run. Any entry added to or removed from that directory therefore moves a number the agent reads, whether or not the writer intended to.

The contract SHALL state that `.copperhead/runs/<run-id>/` entries are runs, and that any sibling entry is not, so a retention policy has a rule to respect and the existing miscount has a definition to be fixed against.

#### Scenario: A non-run entry is not counted as a run

- **WHEN** a file that is not a run directory exists beside the run directories
- **THEN** the contract identifies it as a non-run entry, and `priorRuns` counts only run directories

### Requirement: Artifact retention is run-state aware

Retention SHALL NOT be purely time-based. An artifact belonging to a run that can still be resumed SHALL NOT be eligible for deletion regardless of age.

`.copperhead/runs/<ts>/` is simultaneously agent memory and an artifact source: the resume path reads a prior run's transcript, and the same file is an artifact with a retention window. Deleting on age alone can therefore remove an input a resume depends on.

The mechanism is a platform concern; the constraint originates here, because this repository is what makes the file load-bearing.

#### Scenario: A resumable run's transcript survives its retention window

- **WHEN** an artifact reaches its retention age while the run it belongs to can still be resumed
- **THEN** it is retained, and the resume reads the same transcript it would have read before

### Requirement: The seam types are versioned and carry their own discriminants

The types a hosted runner consumes, `Workspace`, `WritebackResult` and `ArtifactRef`, SHALL be versioned from their first definition, since both streams compile against them and a later change is a cross-stream break.

`ArtifactRef.location` SHALL carry a `kind: 'repo' | 'blob'` discriminant rather than relying on property presence for narrowing. This is distinct from the top-level `ArtifactRef.kind`, which names the artifact's role (`pointer`, `derived`, `log`, `manifest`) and is what the console filters on; the nested discriminant names where the bytes are and is what resolution dispatches on. The two SHALL NOT be merged, since a role that is blob-backed today would otherwise encode that coincidence as a constraint.

`WritebackResult` SHALL distinguish an empty diff from writeback being disabled for the run. Whether hosted runs can disable writeback is a platform question, so this state is provisional; it is included rather than deferred because adding a state later breaks stream 1's exhaustive match, while an unused state costs one unreachable branch.

#### Scenario: A reference artifact resolves without ambiguity

- **WHEN** a consumer receives an `ArtifactRef` whose `location.kind` is `repo`
- **THEN** it resolves the path at the recorded commit, with no inference from which properties are present

#### Scenario: A skipped writeback is distinguishable from an empty one

- **WHEN** a run completes with writeback disabled by policy
- **THEN** the result names that state, and is not reported as having had nothing to write

# schematic-scoring: Delta Spec

## ADDED Requirements

### Requirement: Per-sheet scores and hierarchy aggregate

On a hierarchical design the scorer SHALL compute the full metric set and composite per sheet (top sheet included) and roll the per-sheet composites into a placed-part-count-weighted aggregate, reporting every per-sheet breakdown alongside the aggregate. An error-severity legibility finding on any sheet SHALL cap the aggregate below the known-good floor, naming the sheet that caused the cap. Score surfaces (run summary, `check --json`, `copperhead score schematic`) SHALL carry the per-sheet composites and the aggregate.

#### Scenario: Aggregate is weighted and attributed (AC-17.11)

- **WHEN** the scorer runs on a hierarchical design
- **THEN** the output reports each sheet's composite and breakdown, the part-count weights, and the aggregate

#### Scenario: One bad sheet caps the aggregate

- **WHEN** every sheet scores above the floor but one child sheet carries an error-severity finding
- **THEN** the aggregate is capped below the known-good floor and the cap names that sheet

## MODIFIED Requirements

### Requirement: Golden benchmark corpus

The repository SHALL carry a three-tier golden corpus with pinned expectations enforced in CI. Tier A: known-good hand-drawn sheets (permissively licensed, each with a provenance note) pinned to zero error-severity checker findings and a composite at or above a documented floor. Tier B: known-bad sheets, including one synthetic fixture per gating check family, pinned to their exact finding lists and a composite at or below a documented ceiling. Tier C: reference IRs drafted on every CI run, pinned to byte-identical output and their full score JSON, including at least one hierarchical reference IR whose emitted file set (top sheet and every child sheet) is pinned byte-exactly per file with per-sheet and aggregate scores; the existing flat reference IRs SHALL remain pinned unchanged, proving flat mode is untouched. A CI run SHALL fail when any pin is violated.

#### Scenario: False positive is caught by Tier A (AC-16.16)

- **WHEN** a checker or scorer change causes an error-severity finding on a Tier A sheet
- **THEN** CI fails naming the sheet and the finding

#### Scenario: Detection regression is caught by Tier B (AC-16.17)

- **WHEN** a change stops a Tier B fixture's pinned finding from being reported
- **THEN** CI fails naming the fixture and the missing finding

#### Scenario: Engine regression is caught by Tier C (AC-16.18)

- **WHEN** an engine change alters a Tier C output's bytes or lowers its pinned score
- **THEN** CI fails with the file diff or the score delta

#### Scenario: Hierarchical golden pins the file set (AC-17.12)

- **WHEN** a change alters any file of the hierarchical Tier C reference's emitted set, or moves a per-sheet or aggregate score
- **THEN** CI fails naming the file or the score delta

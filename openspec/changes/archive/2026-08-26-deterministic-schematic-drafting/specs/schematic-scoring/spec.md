# schematic-scoring — Delta Spec

## ADDED Requirements

### Requirement: Deterministic quantitative scoring

The scorer SHALL compute, deterministically and without LLM or network access, at least these metrics over a schematic: wire crossings, wire bends, total wire length, symbol-alignment consistency, page utilization, label-to-wire ratio, group cohesion (mean intra-group versus cross-group connection distance), and flow-direction violations, plus these aesthetic metrics quantifying how deliberately drawn the sheet appears: axis-alignment ratio (fraction of symbols sharing a row or column axis with a neighbour), spacing uniformity (variance of gaps between sibling symbols), straight-wire ratio (fraction of wires with zero bends), label alignment consistency (shared baselines and orientations), whitespace balance (offset of the content centroid from the usable-frame center), and symmetry of recognized paired structures, plus the legibility checker's finding counts. Metrics SHALL be reported at full precision before rounding.

#### Scenario: Scoring is reproducible (AC-16.14)

- **WHEN** the scorer runs twice on the same schematic
- **THEN** every metric and the composite are identical

#### Scenario: Aesthetic metrics are measured (AC-16.32)

- **WHEN** the scorer runs on any sheet
- **THEN** the breakdown reports axis-alignment ratio, spacing uniformity, straight-wire ratio, label alignment, whitespace balance, and pair symmetry as individual metrics with their weights and contributions

### Requirement: Weighted composite with an error cap

The scorer SHALL roll the metrics into a 0-100 composite using weights from the `legibility` config block (documented defaults when absent), and SHALL always report the per-metric breakdown alongside the composite. Any error-severity legibility finding SHALL cap the composite below the known-good floor, so a high score can never coexist with a gating defect.

#### Scenario: Error finding caps the score (AC-16.15)

- **WHEN** a sheet scores well on every metric but carries one error-severity legibility finding
- **THEN** the reported composite is capped below the Tier A floor and the cap is stated in the breakdown

#### Scenario: Breakdown is always present

- **WHEN** the scorer reports any composite
- **THEN** the output names each metric's raw value, weight, and contribution

### Requirement: Score surfaces

The score SHALL surface in three places: recorded in the run summary of any create run that drafts a schematic; present in `check --json` under `legibility.score` as advisory data that never affects the exit code; and available standalone via `copperhead score schematic`, which SHALL be LLM-free and network-free.

#### Scenario: Run summary records the score

- **WHEN** a create run's schematic stage completes
- **THEN** the run summary records the composite and breakdown for the drafted sheet

#### Scenario: score command is offline

- **WHEN** `copperhead score schematic` runs
- **THEN** no language-model call and no network request is made, and the score JSON is printed

### Requirement: Golden benchmark corpus

The repository SHALL carry a three-tier golden corpus with pinned expectations enforced in CI. Tier A: known-good hand-drawn sheets (permissively licensed, each with a provenance note) pinned to zero error-severity checker findings and a composite at or above a documented floor. Tier B: known-bad sheets, including one synthetic fixture per gating check family, pinned to their exact finding lists and a composite at or below a documented ceiling. Tier C: reference IRs drafted on every CI run, pinned to byte-identical output and their full score JSON. A CI run SHALL fail when any pin is violated.

#### Scenario: False positive is caught by Tier A (AC-16.16)

- **WHEN** a checker or scorer change causes an error-severity finding on a Tier A sheet
- **THEN** CI fails naming the sheet and the finding

#### Scenario: Detection regression is caught by Tier B (AC-16.17)

- **WHEN** a change stops a Tier B fixture's pinned finding from being reported
- **THEN** CI fails naming the fixture and the missing finding

#### Scenario: Engine regression is caught by Tier C (AC-16.18)

- **WHEN** an engine change alters a Tier C output's bytes or lowers its pinned score
- **THEN** CI fails with the file diff or the score delta

### Requirement: Deliberate golden regeneration

Golden files SHALL be regenerated only through an explicit update path (`--update-goldens`), producing a reviewable diff of both file bytes and score breakdowns. Silent or implicit golden updates SHALL NOT occur.

#### Scenario: Goldens change only on request

- **WHEN** the test suite runs without the update flag and outputs differ from goldens
- **THEN** the suite fails and no golden file is modified

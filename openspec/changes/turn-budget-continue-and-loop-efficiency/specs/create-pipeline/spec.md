# create-pipeline delta spec

## ADDED Requirements

### Requirement: Per-stage turn budgets

`.copperhead/config.json` SHALL accept an optional `stageMaxTurns` object mapping create-pipeline stage names to turn budgets. When a stage runs and its name has an entry, that value SHALL be the run's `maxTurns`; stages without an entry use the global `maxTurns`, except `part-selection`, whose default SHALL be `max(maxTurns, ceil(rows * 0.4) + 10)`, where `rows` is the larger of the BOM.md row count when the attempt starts and the most rows an earlier attempt of the stage wrote before its rollback. Unknown stage names in the map SHALL be ignored.

#### Scenario: Stage-specific budget applies (AC-15.18)

- **WHEN** config contains `"stageMaxTurns": {"spec-seed": 60}` and the spec-seed stage runs
- **THEN** that stage's run enforces a 60-turn budget while other stages keep the global `maxTurns`

#### Scenario: Absent map keeps the configured budget as the floor (AC-15.19)

- **WHEN** config has `"maxTurns": 100`, no `stageMaxTurns`, and a 10-row BOM
- **THEN** every stage, part selection included, runs with a 100-turn budget

#### Scenario: Part-selection retry is sized from the rolled-back attempt (AC-15.19)

- **WHEN** part selection starts from the header-only BOM scaffold with the default `maxTurns` of 40, writes 100 rows, and is rolled back
- **THEN** the first attempt runs with 40 turns and the retry runs with `ceil(100 * 0.4) + 10 = 50` turns

### Requirement: Content-aware stage completion

Stage completion SHALL be judged by repo state, not artifact existence alone: the schematic stage is complete only when the configured schematic contains at least one symbol AND the BOM/PINOUT tables are drift-clean against it; the layout-draft stage is complete only when a configured board exists containing at least one footprint AND the LAYOUT.md draft-quality marker is present. After a stage's agent run finishes with outcome success, `create` SHALL re-check that stage's completion contract and halt the pipeline (preserving committed partial work, with a resume hint) if the contract is not met, instead of advancing to later stages.

#### Scenario: Blank sheet does not complete the schematic stage (AC-15.23)

- **WHEN** the schematic stage's run succeeds but the configured schematic contains zero symbols
- **THEN** `create` reports the stage contract as unmet, does not advance, and a re-run of `copperhead create` resumes at the schematic stage

#### Scenario: Pipeline halts on planning-only output (AC-15.24)

- **WHEN** any stage's agent run returns success without satisfying that stage's completion contract
- **THEN** `runCreate` returns not-ok with the completed-stage list so far, and later stages do not run

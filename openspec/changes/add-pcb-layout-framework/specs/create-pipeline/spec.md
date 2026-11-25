# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Layout stage runs the framework
The layout-draft stage SHALL call `pcb layout` under the configured profile: import, ECAD ingestion, intent compilation (the model authors intent through the registry, never coordinates), placement and routing through eligible wrapped engines, verification, scoring, and the repair loop within the stage's engine-second budget. The stage SHALL end with the evidence bundle written and `docs/LAYOUT.md`'s `## Draft quality` generated from it: satisfied constraints, unsatisfied constraints, engines run, winner and reason, raw metrics, fabrication profile. `HOLD` SHALL halt the pipeline with the resume hint; `REFUSE` SHALL take the existing refusal path.

#### Scenario: Draft quality is evidence (AC-17.15)
- **WHEN** the layout-draft stage completes with status `PARTIAL`
- **THEN** `## Draft quality` lists every unsatisfied constraint and unrouted connection by name, the engines that ran with versions, and the selected candidate's metrics, and the run summary links the bundle

## MODIFIED Requirements

### Requirement: Content-aware stage completion
Stage completion SHALL be judged by repo state, not artifact existence alone: the schematic stage is complete only when the configured schematic contains at least one symbol AND the BOM/PINOUT tables are drift-clean against it AND ERC passes AND the schematic reports zero error-severity legibility findings AND, when the sheet was engine-drafted, the schematic matches a re-draft of the current IR and its score composite and breakdown are recorded in the run summary; the layout-draft stage is complete only when a configured board exists containing at least one footprint AND an evidence bundle for the board's current content hash exists with status `PASS` or `PARTIAL` AND the LAYOUT.md draft-quality section was generated from that bundle. After a stage's agent run finishes with outcome success, `create` SHALL re-check that stage's completion contract and halt the pipeline (preserving committed partial work, with a resume hint) if the contract is not met, instead of advancing to later stages.

#### Scenario: Blank sheet does not complete the schematic stage (AC-15.23)
- **WHEN** the schematic stage's run succeeds but the configured schematic contains zero symbols
- **THEN** `create` reports the stage contract as unmet, does not advance, and a re-run of `copperhead create` resumes at the schematic stage

#### Scenario: Pipeline halts on planning-only output (AC-15.24)
- **WHEN** any stage's agent run returns success without satisfying that stage's completion contract
- **THEN** `runCreate` returns not-ok with the completed-stage list so far, and later stages do not run

#### Scenario: Illegible sheet does not complete the schematic stage (AC-16.22)
- **WHEN** the schematic stage's run succeeds with symbols present and drift clean, but the checker reports error-severity legibility findings
- **THEN** `create` reports the stage contract as unmet with the finding counts by kind, does not advance, and a re-run resumes at the schematic stage

#### Scenario: Advisory findings do not block the stage
- **WHEN** the schematic reports only advisory legibility findings
- **THEN** the stage completes and the advisories are recorded in the run summary

#### Scenario: Stale draft does not complete the stage (AC-16.20)
- **WHEN** the schematic on disk does not match a re-draft of the current IR (the IR changed after the last draft)
- **THEN** `create` reports the stage contract as unmet with a resume hint to re-draft, and does not advance

#### Scenario: Score is recorded on completion (AC-16.21)
- **WHEN** the schematic stage completes with an engine-drafted sheet
- **THEN** the run summary records the score composite and per-metric breakdown

#### Scenario: Stale evidence does not complete the layout stage (AC-17.16)
- **WHEN** the board's content hash differs from the hash the evidence bundle was written for
- **THEN** `create` reports the layout-draft contract as unmet with a hint to re-run `pcb layout`, and does not advance

# create-pipeline: Delta Spec

## ADDED Requirements

### Requirement: Per-sheet drafting loop

In hierarchical mode the schematic stage SHALL iterate per sheet after the initial full-hierarchy draft: select the first sheet carrying error-severity findings, repair through the IR, re-draft, and re-check that sheet, with findings and repair context scoped to the sheet under repair. A sheet whose findings are clean and whose sheet-scoped obligations are closed SHALL be committable immediately, without waiting for the remaining sheets. A later regression confined to one sheet SHALL roll back that sheet's diff only; committed clean sheets SHALL NOT be discarded by another sheet's failure or by stage-level rollback of uncommitted work.

#### Scenario: Clean sheets survive a later regression (AC-17.9)

- **WHEN** two child sheets have been drafted clean and committed, and a subsequent IR revision regresses a third sheet past the repair cycle cap
- **THEN** the rollback discards only the third sheet's uncommitted diff, and the two committed sheets are untouched

#### Scenario: Findings are scoped to the sheet under repair

- **WHEN** the stage iterates on a sheet with error-severity findings
- **THEN** the repair turn's findings list names only that sheet's findings, not the whole hierarchy's

## MODIFIED Requirements

### Requirement: Content-aware stage completion

Stage completion SHALL be judged by repo state, not artifact existence alone: the schematic stage is complete only when the configured schematic contains at least one symbol AND the BOM/PINOUT tables are drift-clean against it AND ERC passes (invoked once from the root sheet when the design is hierarchical) AND every sheet in the hierarchy reports zero error-severity legibility findings AND, when the sheet was engine-drafted, the schematic matches a re-draft of the current IR across every emitted file and its score composite and breakdown are recorded in the run summary (per sheet plus the aggregate when hierarchical); the layout-draft stage is complete only when a configured board exists containing at least one footprint AND the LAYOUT.md draft-quality marker is present. After a stage's agent run finishes with outcome success, `create` SHALL re-check that stage's completion contract and halt the pipeline (preserving committed partial work, with a resume hint) if the contract is not met, instead of advancing to later stages.

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

#### Scenario: One dirty sheet holds the stage (AC-17.10)

- **WHEN** every child sheet but one is clean and committed, and that one sheet still carries error-severity findings
- **THEN** `create` reports the stage contract as unmet naming that sheet and its finding counts, preserves the committed sheets, and a re-run resumes at the schematic stage on that sheet

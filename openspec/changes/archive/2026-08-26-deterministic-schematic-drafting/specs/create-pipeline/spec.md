# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Schematic stage splits intent from drafting

The schematic stage SHALL be structured as intent authoring followed by deterministic drafting: the agent authors the netlist-intent IR (parts, connections, group assignments from SUBSYSTEMS.md, optional hints) and calls `draft_schematic`; the engine computes all geometry and writes the sheet. The stage's instruction SHALL direct the agent to author intent, never coordinates, and to repair gate findings by revising the IR and re-drafting.

#### Scenario: Model authors no geometry (AC-16.19)

- **WHEN** the schematic stage runs to completion in drafting mode
- **THEN** every geometry element in the schematic was written by the engine, and the transcript contains no `edit_file` call against the schematic

#### Scenario: Repairs go through the IR

- **WHEN** ERC or the legibility checker reports a defect on a drafted sheet
- **THEN** the stage instruction directs the agent to fix the IR and call `draft_schematic` again, and the re-draft fully regenerates the sheet

### Requirement: Schematic stage states the drafting standard

The schematic stage's instruction SHALL state the drafting standard the drafted sheet must satisfy: one drawn group box with a caption per subsystem taken from SUBSYSTEMS.md, groups tiled without overlap, left-to-right signal flow, power rails toward the top and grounds toward the bottom, net labels rather than long wires between groups, a paper size chosen so the groups fill the frame, and a populated title block. The instruction SHALL make clear that the engine enforces the standard geometrically and that the agent's levers are the IR's group assignments and hints, plus running `check_legibility` and reconciling every error-severity finding before finishing.

#### Scenario: Standard is present in the stage instruction

- **WHEN** the schematic stage builds its prompt
- **THEN** the instruction text states the group-box, block-partitioning, inter-group labelling, page-sizing, and title-block rules, and directs the agent to reconcile error-severity legibility findings through the IR

## MODIFIED Requirements

### Requirement: Content-aware stage completion

Stage completion SHALL be judged by repo state, not artifact existence alone: the schematic stage is complete only when the configured schematic contains at least one symbol AND the BOM/PINOUT tables are drift-clean against it AND ERC passes AND the schematic reports zero error-severity legibility findings AND, when the sheet was engine-drafted, the schematic matches a re-draft of the current IR and its score composite and breakdown are recorded in the run summary; the layout-draft stage is complete only when a configured board exists containing at least one footprint AND the LAYOUT.md draft-quality marker is present. After a stage's agent run finishes with outcome success, `create` SHALL re-check that stage's completion contract and halt the pipeline (preserving committed partial work, with a resume hint) if the contract is not met, instead of advancing to later stages.

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

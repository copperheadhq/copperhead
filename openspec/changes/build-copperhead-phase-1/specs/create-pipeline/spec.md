# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Brief-to-package pipeline
`copperhead create --brief <file>` SHALL run the staged pipeline — seed `openspec/specs/` from the brief, write SPEC.md budgets, architecture (SUBSYSTEMS.md), part selection (BOM.md), schematic sheet by sheet, first-draft layout, outputs package, firmware scaffold, DEVPLAN.md — where each stage is a `do`-loop run with a stage-specific prompt and gate (spec self-consistency, drift, ERC per sheet, DRC, export success, firmware build).

#### Scenario: Full run yields the package
- **WHEN** `create` completes on a valid brief
- **THEN** `outputs/` contains gerbers+drill zip, DXF/STEP outline, SVG renders, ordering BOM csv, firmware scaffold, pins.h, and DEVPLAN.md, and the KiCad files are ERC/DRC clean

#### Scenario: Unstated decisions flagged
- **WHEN** the brief omits a needed decision (e.g. battery chemistry)
- **THEN** SPEC.md proposes a default flagged `ASSUMED` for review

#### Scenario: Selected parts retain their review flag
- **WHEN** BOM.md names an actual MPN with an `UNVERIFIED` flag
- **THEN** the part-selection completion probe recognizes the named part without removing its flag
- **AND** bare `UNVERIFIED` placeholders do not satisfy the probe, which reads MPNs by their table header

#### Scenario: Partial export is not a complete package
- **WHEN** an export attempt or resumed repo has only some of the output artifacts
- **THEN** the outputs stage remains incomplete until nonempty Gerber, drill, DXF, STEP, board SVG, schematic SVG, and ordering BOM CSV files exist
- **AND** the failure report identifies the missing or empty artifact classes for recovery

### Requirement: Run-to-completion guarantee
Once started, `create` SHALL always finish with the complete output package: gates are quality checks the agent must satisfy, never stops that wait for a human, unless `--interactive` re-enables the spec-approval and pre-export gates.

#### Scenario: Autonomous by default
- **WHEN** `create` runs without `--interactive`
- **THEN** no stage blocks on human input and the run ends with all artifacts on disk

### Requirement: Resumability from repo state
Pipeline state SHALL live in the repo (docs + files + gate results), so a killed `create` re-run SHALL continue from the first incomplete stage without redoing completed ones.

#### Scenario: Resume after kill
- **WHEN** `create` is killed after the BOM stage and re-run
- **THEN** it skips spec/architecture/BOM and resumes at the schematic stage

#### Scenario: Resume does not commit unverified KiCad work
- **WHEN** an earlier stage is complete but the worktree also contains dirty KiCad files
- **THEN** the resume auto-commit runs deterministic verification first and leaves the work uncommitted if verification fails

#### Scenario: Incomplete layout verification survives restart
- **WHEN** a board has footprints and LAYOUT.md has a Draft quality section but DRC fails
- **THEN** the layout stage remains incomplete and must be repaired before the pipeline advances

### Requirement: First-draft layout with honesty gate
The layout stage SHALL produce rule-driven placement (real coordinates in the `.kicad_pcb`) and rule-based routing of power/critical nets, with every routed net passing DRC, and SHALL auto-write a `## Draft quality` section in LAYOUT.md listing what is done and what a human or specialist tool should redo.

#### Scenario: Draft labeled
- **WHEN** the layout stage completes
- **THEN** LAYOUT.md contains a `## Draft quality` section and the board passes DRC

### Requirement: Firmware verification gate
The firmware scaffold SHALL compile clean against the vendor toolchain when one is available; when the toolchain is absent, the run SHALL still complete, marking DEVPLAN.md that the firmware was not compiled locally.

#### Scenario: Toolchain present
- **WHEN** the firmware stage runs with the vendor toolchain installed
- **THEN** the build exits 0 before the stage is marked complete

#### Scenario: Toolchain absent
- **WHEN** no vendor toolchain is installed
- **THEN** the scaffold and pins.h are still produced and DEVPLAN.md carries an explicit "not compiled here" flag

#### Scenario: Empty source file is not a scaffold
- **WHEN** the firmware directory contains only empty source or header files
- **THEN** the firmware stage remains incomplete

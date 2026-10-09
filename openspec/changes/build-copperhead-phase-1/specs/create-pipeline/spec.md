# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Brief-to-package pipeline
`copperhead create --brief <file>` SHALL run the staged pipeline — seed `openspec/specs/` from the brief, write SPEC.md budgets, architecture (SUBSYSTEMS.md), part selection (BOM.md), schematic sheet by sheet, first-draft layout, outputs package, firmware scaffold, DEVPLAN.md — where each stage is a `do`-loop run with a stage-specific prompt and gate (spec self-consistency, drift, ERC per sheet, DRC, export success, firmware build).

#### Scenario: Full run yields the package
- **WHEN** `create` completes on a valid brief
- **THEN** `outputs/` contains gerbers+drill zip, DXF/STEP outline, SVG renders, ordering BOM csv, firmware scaffold and pins.h for programmable designs (or firmware/README.md with verified N/A evidence for supported hardware-only designs), and DEVPLAN.md, and the KiCad files are ERC/DRC clean

#### Scenario: Export reports actual files
- **WHEN** fabrication export succeeds, including a directory-based DXF or a multi-sheet SVG export
- **THEN** its result SHALL retain the artifact labels and report each actual output-relative file path and byte size
- **AND** each reported file SHALL be a nonempty regular file produced by that export, without treating old output files or a zero exit status alone as evidence of success
- **AND** this file validation SHALL NOT claim manufacturer-profile verification

#### Scenario: Unstated decisions flagged
- **WHEN** the brief omits a needed decision (e.g. battery chemistry)
- **THEN** SPEC.md proposes a default flagged `ASSUMED` for review

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

#### Scenario: Supported hardware-only design
- **WHEN** the configured, populated schematic contains only explicitly reviewed non-programmable symbol identities across every sheet, is ERC-clean, and has populated BOM/PINOUT tables with zero drift
- **AND** firmware/README.md has the exact documented N/A declaration and a concrete non-placeholder rationale
- **THEN** stage 7 completes with that committed applicability evidence, with all eight stages and other checks intact and without dummy source files

#### Scenario: Unsupported or missing applicability evidence
- **WHEN** a design contains an MCU, FPGA, programmable module, unknown/custom symbol or unreviewed IC, or the evidence is missing, empty, ambiguous, inconsistent or not ERC-clean
- **THEN** an N/A declaration SHALL NOT complete the firmware stage
- **AND** programmable designs SHALL still produce firmware and meet the existing toolchain requirements

#### Scenario: Empty firmware source
- **WHEN** firmware/ contains only zero-byte or whitespace-only source files
- **THEN** those files SHALL NOT satisfy the firmware artifact requirement

### Requirement: Explicit JLC settings and complete outputs evidence

Stage 6 MUST use the supported explicit KiCad 9 JLC profile and a complete,
source-bound package. Finish and resume MUST reject missing, empty, stale,
altered or incomplete artifacts. Failed reruns MUST invalidate prior success.
Local verification MUST NOT claim manufacturer acceptance or fabrication release.
Existing safety gates and generic `exportFab` compatibility remain unchanged.

#### Scenario: A lone Gerber remains after a failed run

- GIVEN outputs contains a Gerber without a complete current manifest and archive
- WHEN Stage 6 checks completion or attempts to finish
- THEN it remains incomplete and reports the missing package evidence

#### Scenario: A supported zero-zone board exports successfully

- GIVEN a KiCad 9 board with no copper-fill zones and a complete ordering BOM
- WHEN all configured exports succeed with the expected local metadata
- THEN the package records current source/file hashes and a verified ZIP
- AND it includes all selected manufacturing layers, separate PTH/NPTH drills, ordering BOM, and required mechanical/render exports
- AND it explicitly records manufacturer acceptance as unverified

#### Scenario: Fill validation is unsupported

- GIVEN a board or footprint contains a copper-fill zone
- WHEN export_outputs is called
- THEN it fails before plotting and names the missing fill-validation workflow
- AND it does not mutate the board, suppress the gate, or claim profile success

#### Scenario: Unsupported major version

- GIVEN an installed KiCad major version other than the supported profile version
- WHEN export_outputs is called
- THEN it fails with the unsupported-version reason instead of claiming profile success

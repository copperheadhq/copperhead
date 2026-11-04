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
The firmware scaffold SHALL compile clean against the vendor toolchain when one is available; when the toolchain is absent, the run SHALL still complete, marking DEVPLAN.md that the firmware was not compiled locally. A board whose schematic has nothing programmable on it SHALL complete the stage without source, on a `firmware/README.md` that begins `# No firmware` and states why; the schematic, not the model, SHALL decide that.

#### Scenario: Toolchain present
- **WHEN** the firmware stage runs with the vendor toolchain installed
- **THEN** the build exits 0 before the stage is marked complete

#### Scenario: Toolchain absent
- **WHEN** no vendor toolchain is installed
- **THEN** the scaffold and pins.h are still produced and DEVPLAN.md carries an explicit "not compiled here" flag

#### Scenario: No programmable part
- **WHEN** every schematic symbol comes from a stock non-programmable KiCad library (`Device`, `Connector*`, `Diode*`, `Transistor_*`, `Regulator_*`, `Mechanical`, `power`, `Power_Protection`, `LED`, `Switch`, `Jumper`, `Graphic`, `Amplifier_Operational`, `Amplifier_Instrumentation`, `Comparator`, `Reference_Voltage`, `Relay`, `Timer`) and `firmware/README.md` begins `# No firmware` with a reason below it (an HTML comment is not one)
- **THEN** the firmware stage completes with no source under `firmware/`

#### Scenario: Unknown part never waives firmware
- **WHEN** `firmware/README.md` begins `# No firmware` but the schematic has a part from any other library (a stock MCU library or a project library such as `fixture:ESP32-S3-MINI`), or no readable schematic with parts
- **THEN** the firmware stage stays incomplete until source exists under `firmware/`, and the stage's failure detail names the parts that need it

### Requirement: Parts manifest and draft_bom engine
Stage 3 part selection SHALL validate `docs/parts.intent.json` and render `docs/BOM.md` via the deterministic `draft_bom` capability. The manifest SHALL follow schema version 1, expand passive packages deterministically, enforce bidirectional subsystem coverage with SUBSYSTEMS.md, and resolve all symbols and footprints against local libraries before rendering.

#### Scenario: Manifest validated and BOM rendered
- **WHEN** `draft_bom` runs with a valid parts manifest
- **THEN** `docs/parts.intent.json` and canonical `docs/BOM.md` are written atomically, and the stage is marked complete

#### Scenario: Missing library symbol or footprint rejected
- **WHEN** a manifest references an uninstalled symbol or footprint
- **THEN** `draft_bom` refuses with structured validation findings and does not overwrite existing BOM files

### Requirement: Exact symbol identity propagation
Stage 4 schematic drafting SHALL consume the exact `Symbol` (`libId`) recorded in `docs/BOM.md` without fuzzy fallback. Off-board components marked `(off-board)` SHALL be excluded from the schematic sheet.

#### Scenario: Schematic consumes exact BOM libId
- **WHEN** schematic drafting populates symbols
- **THEN** the symbols on the sheet match the exact `libId` values from BOM.md, and off-board items are omitted

### Requirement: Manifest check and drift verification
`copperhead check` SHALL validate `docs/parts.intent.json` against installed KiCad libraries and verify that `docs/BOM.md` matches `renderBomMarkdown` when a manifest is present.

#### Scenario: Desynced BOM detected
- **WHEN** `docs/parts.intent.json` exists but `docs/BOM.md` does not match its deterministic rendering
- **THEN** `check` fails reporting manifest drift, while legacy repos without a manifest pass without error

# create-pipeline — Delta Spec

## MODIFIED Requirements

### Requirement: Brief-to-package pipeline
`copperhead create --brief <file>` SHALL run the staged pipeline — seed `openspec/specs/` from the brief, write SPEC.md budgets, architecture (SUBSYSTEMS.md), part selection (BOM.md), schematic sheet by sheet, first-draft layout, outputs package, firmware scaffold, DEVPLAN.md — where each stage is a `do`-loop run with a stage-specific prompt and gate (spec self-consistency, drift, ERC per sheet, DRC, export success, firmware build). The outputs-package stage SHALL additionally emit the JLCPCB-format assembly BOM via the supplier-bom-export capability, and SHALL commit it under the outputs stage's name when it is the only changed path, so no later commit attributes it to another stage.

#### Scenario: Full run yields the package
- **WHEN** `create` completes on a valid brief
- **THEN** `outputs/` contains gerbers+drill zip, DXF/STEP outline, SVG renders, ordering BOM csv, the JLCPCB-format assembly BOM, firmware scaffold, pins.h, and DEVPLAN.md, and the KiCad files are ERC/DRC clean

#### Scenario: JLCPCB BOM committed under the outputs stage
- **WHEN** the outputs stage completes (or is resumed past) and the emitted JLCPCB BOM is the only changed path
- **THEN** it is committed as `copperhead: create pipeline stage: outputs (JLCPCB assembly BOM)`, the tree is left clean, and no later stage or resume commit contains it; when other paths are also dirty it is left uncommitted with a warning

#### Scenario: Unstated decisions flagged
- **WHEN** the brief omits a needed decision (e.g. battery chemistry)
- **THEN** SPEC.md proposes a default flagged `ASSUMED` for review

# Manufacturing package integrity

## Purpose

Verify an explicitly bounded local export profile and a current fabrication-file package while keeping manufacturer acceptance separate.

## ADDED Requirements

### Requirement: Explicit supported export settings

The explicit opt-in `jlcpcb-kicad9-2026-09-24` package profile SHALL support KiCad 9 with no copper-fill zones, select the board's copper stack plus mask, legend, outline and paste layers, and explicitly use absolute metric decimal Excellon drilling with alternate oval slots and separate PTH/NPTH. Unsupported versions or fill validation SHALL fail without claiming success.

#### Scenario: Supported board and expected metadata

- **WHEN** a KiCad 9 board without copper-fill zones exports all selected layers and both drill kinds
- **THEN** the package validates layer, format and drill metadata before recording success

#### Scenario: Unsupported copper fill

- **WHEN** the board or a footprint contains a copper-fill zone
- **THEN** export fails before plotting with a fill-validation explanation
- **AND** rule-area keepouts remain supported because they contain no copper fill

### Requirement: Ordering and archive evidence

A completed package SHALL include the required mechanical/render exports, ordering BOM, manufacturing-only ZIP and manifest. Ordering rows SHALL use unique individual refdes values and non-placeholder MPNs. The deterministic archive SHALL contain exactly the current manufacturing files within the documented filename and size bounds.

#### Scenario: Unrelated stale files exist

- **WHEN** a supported export completes beside unrelated files left by an earlier attempt
- **THEN** only the current verified manufacturing inventory enters the ZIP

#### Scenario: Placeholder ordering part

- **WHEN** an orderable component BOM row lacks an MPN or uses N/A, including spaced or case-varied N/A
- **THEN** the package fails and does not mark the ordering BOM complete

#### Scenario: Archive is changed

- **WHEN** archive bytes, entry names or contents differ from the verified inventory
- **THEN** the completion probe rejects the archive rather than relying on its existence or size

### Requirement: Source-bound freshness and honest status

The manifest SHALL record actual paths, sizes, file/source hashes, profile/version and unverified manufacturer acceptance. Freshness SHALL cover the board, schematic hierarchy, BOM and present project settings. Failed reruns SHALL invalidate prior success. These checks SHALL NOT claim factory acceptance, complete external-dependency coverage or physical qualification.

#### Scenario: Failed rerun after success

- **WHEN** a later export fails after a previous successful package
- **THEN** its manifest is incomplete and the previous success cannot complete the stage

#### Scenario: External acceptance remains unverified

- **WHEN** all local profile, inventory and freshness checks pass
- **THEN** the result still identifies manufacturer acceptance as unverified
- **AND** raw DRC findings, routing quality and unperformed hardware tests retain their existing meanings

### Requirement: Compatible default exports

An omitted or `generic` outputProfile SHALL use ordinary KiCad export arguments,
including board-only projects and boards with copper zones. It SHALL record
profile verification as not requested and zone fill as unverified. Unknown
profiles SHALL fail. Explicit JLC failures SHALL NOT fall back to generic.

#### Scenario: Board-only export

- **WHEN** a generic project has a board and no configured schematic or BOM
- **THEN** the export tool produces its real board exports and integrity inventory
- **AND** it does not claim complete create Stage 6 or JLC profile success

#### Scenario: Complete generic Stage 6

- **WHEN** all board manufacturing layers, drill, DXF, STEP, board/schematic SVGs, ordering BOM and generic archive exist with matching sources and hashes
- **THEN** the stage can complete without requiring KiCad 9 JLC settings
- **AND** profile, fill and manufacturer acceptance remain unverified

#### Scenario: Profile switch or missing legacy manifest

- **WHEN** the configured profile differs from the manifest or the manifest is absent
- **THEN** finish and resume require export_outputs to be rerun
- **AND** they never reinterpret or manufacture historical verification

#### Scenario: Technical layers in a generic export

- **WHEN** ordinary Gerber export produces technical layers as well as manufacturing layers
- **THEN** fabrication.zip contains only the board inventory's copper (including inner layers), mask, silk, paste, outline and drill files
- **AND** Fab, Courtyard, drawing/comment/user layers, job metadata and drill maps remain on disk and in the raw manifest inventory, outside the ZIP

#### Scenario: Fabrication-only and explicitly unpopulated rows

- **WHEN** a missing-MPN row has a MountingHole, TestPoint or Fiducial footprint, or is explicitly marked DNP/DNI/not fitted
- **THEN** the ordering CSV SHALL exclude it and report its reference as a warning
- **AND** missing electronic-part MPNs SHALL remain failures with an actionable reference-specific message
- **AND** a CSV with no orderable components SHALL NOT complete Stage6

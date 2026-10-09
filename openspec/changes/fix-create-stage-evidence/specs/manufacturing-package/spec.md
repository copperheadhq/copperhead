# Manufacturing package integrity

## Purpose

Verify an explicitly bounded local export profile and a current fabrication-file package while keeping manufacturer acceptance separate.

## ADDED Requirements

### Requirement: Explicit supported export settings

The initial package profile SHALL support KiCad 9 with no copper-fill zones, select the board's copper stack plus mask, legend, outline and paste layers, and explicitly use absolute metric decimal Excellon drilling with alternate oval slots and separate PTH/NPTH. Unsupported versions or fill validation SHALL fail without claiming success.

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

- **WHEN** a BOM row lacks an MPN or uses N/A, including spaced or case-varied N/A
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

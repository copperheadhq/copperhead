# Agent verification evidence

## Purpose

Distinguish verified generated definitions and actual export files from labels or prefixes that do not establish a valid artifact.

## ADDED Requirements

### Requirement: Exact generated power definition verification

The symbol verifier SHALL compare reserved generated power definitions against the engine's complete canonical parsed templates. PWR_FLAG SHALL retain its dedicated definition. A prefix alone SHALL never exempt a definition, and ordinary installed-library comparison SHALL remain in force.

#### Scenario: Valid named rails stay distinct

- **WHEN** VBUS_RAW and +5V_PROTECTED definitions exactly match their engine templates
- **THEN** verification accepts them without rewriting the schematic or collapsing net names

#### Scenario: Reserved-prefix counterfeit

- **WHEN** a reserved-prefix definition changes metadata, graphics or pins, or contains an arbitrary component body
- **THEN** verification reports a blocking generated-symbol finding instead of skipping an unavailable library

### Requirement: Fresh export file inventory

Fabrication exports SHALL retain stable artifact labels and separately report actual relative paths and byte sizes. Each job SHALL verify fresh nonempty regular files of the expected format before reporting success. Old files, empty directories and a zero exit code alone SHALL not establish success.

#### Scenario: Directory DXF and multiple SVG pages

- **WHEN** KiCad writes a DXF under an output directory and one SVG per schematic page
- **THEN** the inventory reports every actual file path and size rather than inventing a single schematic.svg path

#### Scenario: Successful exit with no output

- **WHEN** an exporter exits zero but creates no matching nonempty regular file
- **THEN** that artifact is reported failed even if earlier output files remain

#### Scenario: Known destination conflict

- **WHEN** a later destination in a multi-file job is a directory or symbolic link
- **THEN** all destinations are checked before any existing file in that job is replaced
- **AND** no claim of transaction atomicity against arbitrary disk failure is made

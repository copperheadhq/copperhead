# Capability: Pattern BOM Reference

## ADDED Requirements

### Requirement: Pattern-to-BOM Expansion Helper
The system SHALL provide a pure function `expandPatternToBomRows` that loads a named circuit pattern from `src/kicad/patterns/<name>.json` and produces standard 5-column BOM rows with `from pattern: <name>` in the Rationale column.

#### Scenario: Expanding a named pattern into BOM rows
- **WHEN** `expandPatternToBomRows("voltage-regulator-ams1117")` is called
- **THEN** it returns 3 BOM rows corresponding to the AMS1117 regulator and its two decoupling capacitors
- **AND** each row has the Rationale column set to `"from pattern: voltage-regulator-ams1117"`

#### Scenario: Requesting an unknown pattern name
- **WHEN** `expandPatternToBomRows("unknown-pattern")` is called
- **THEN** it throws an error indicating the pattern file was not found

### Requirement: Stage 3 Pattern Reference Resolution
Stage 3 of the create pipeline SHALL recognize pattern reference declarations (e.g. `use pattern: <name>`) in `BOM.md` and expand them into concrete BOM rows.

#### Scenario: Resolving pattern references in BOM.md
- **WHEN** `docs/BOM.md` contains a line `use pattern: voltage-regulator-ams1117`
- **THEN** the pipeline resolves the pattern reference into concrete BOM rows with `"from pattern: voltage-regulator-ams1117"` rationale
- **AND** logs `Resolved pattern "voltage-regulator-ams1117" -> 3 parts added to BOM.md`

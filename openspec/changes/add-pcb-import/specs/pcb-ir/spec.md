# pcb-ir — Delta Spec

## ADDED Requirements

### Requirement: A KiCad board imports into a layout input
The `pcb-ir` unit SHALL compile a `.kicad_pcb` into an RFC 11 version 1.4
layout input, as Section 5.1 allows an adapter that does not pass through the
kernel. Identifiers SHALL be derived as RFC 3 Section 4.2 specifies: UUIDv5 of
the project namespace and the entity's kind and path. A part's path SHALL be
its schematic symbol path where the board records one, and otherwise its KiCad
identifier; routing's path SHALL be its KiCad identifier, or else its content,
never its position in the file. Each ring of the board outline SHALL run
counter-clockwise as seen from the front, starting at its least point by x and
then y. Every placement SHALL be owned by the import adapter. The layout
input's parent SHALL name the imported file by the hash of its bytes. Whatever
the import cannot represent faithfully, such as copper on no net, SHALL be
listed in the board's `lossy` field.

#### Scenario: The import validates
- **WHEN** a board is imported
- **THEN** the layout input validates against the RFC 11 schema
- **AND** each footprint definition is keyed by its content hash

#### Scenario: Identifiers follow RFC 3
- **WHEN** the board record of project `ldo-board` is derived
- **THEN** its identifier is `PCB-217f1404b81d`, as in the RFC's example

#### Scenario: Renumbering keeps identity
- **WHEN** a part's reference designator changes in the board file, whether
  the part has a schematic symbol or is placed only on the board
- **THEN** its component identifier does not

#### Scenario: File order does not matter
- **WHEN** the footprints of a board file are reordered
- **THEN** the imported layout input is the same apart from its parent's hash
- **AND WHEN** its traces are reordered, with KiCad identifiers or without
- **THEN** each trace keeps its identifier
- **AND WHEN** the edges of its outline are drawn in another order or direction
- **THEN** the outline is the same

#### Scenario: Copper on no net is reported
- **WHEN** a board has a trace on no net
- **THEN** the trace is not imported, and the board's `lossy` field says so

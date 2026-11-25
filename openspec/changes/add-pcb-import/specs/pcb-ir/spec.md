# pcb-ir — Delta Spec

## ADDED Requirements

### Requirement: A KiCad board imports into a layout input
The `pcb-ir` unit SHALL compile a `.kicad_pcb` into an RFC 11 version 1.4
layout input, as Section 5.1 allows an adapter that does not pass through the
kernel. Identifiers SHALL be derived as RFC 3 Section 4.2 specifies: UUIDv5 of
the project namespace and the entity's kind and path. A part's path SHALL be
its schematic symbol path where the board records one. Every placement SHALL
be owned by the import adapter. The layout input's parent SHALL name the
imported file by the hash of its bytes. Whatever the import cannot represent
faithfully SHALL be listed in the board's `lossy` field.

#### Scenario: The import validates
- **WHEN** a board is imported
- **THEN** the layout input validates against the RFC 11 schema
- **AND** each footprint definition is keyed by its content hash

#### Scenario: Identifiers follow RFC 3
- **WHEN** the board record of project `ldo-board` is derived
- **THEN** its identifier is `PCB-217f1404b81d`, as in the RFC's example

#### Scenario: Renumbering keeps identity
- **WHEN** a part's reference designator changes in the board file
- **THEN** its component identifier does not

#### Scenario: File order does not matter
- **WHEN** the footprints of a board file are reordered
- **THEN** the imported layout input is the same apart from its parent's hash

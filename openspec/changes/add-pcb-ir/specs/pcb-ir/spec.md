# pcb-ir — Delta Spec

## ADDED Requirements

### Requirement: Layout record types come from the published schemas
The `pcb-ir` unit SHALL define the RFC 11 version 1.4 layout records by the JSON
Schemas published in the RFC repository, vendored unchanged under
`src/pcb-ir/schemas/rfc11/`. The unit's TypeScript types SHALL be generated from
those schemas by `scripts/gen-pcb-ir-types.ts` and SHALL NOT be edited by hand.

#### Scenario: The generated types are current
- **WHEN** the type generator runs over the vendored schemas
- **THEN** its output equals the committed `src/pcb-ir/types.generated.ts`

#### Scenario: The RFC's examples validate
- **WHEN** each example record vendored in `test/fixtures/rfc11/` is validated
  against its schema
- **THEN** every one is valid

### Requirement: Content hashes equal the kernel's
`contentHash` SHALL be sha256 over the canonical bytes of RFC 3 version 1.6,
Section 17.1:
- mapping keys sorted by Unicode code point, after NFC
- an entity sorted by its identifier, and any other item by its canonical
  serialization
- arrays kept in order exactly when their key is in the declared ordered set
- a bare number as the shortest round-trip decimal, written positionally
- a non-finite number refused
- one trailing newline

#### Scenario: The RFC's cited hashes reproduce
- **WHEN** every hash the example records cite to one another is recomputed
- **THEN** each names an example's content hash, and each footprint key equals
  the hash of its definition

#### Scenario: Equal collections hash equally
- **WHEN** two findings without identifiers share a `code` and are serialized
  in either order
- **THEN** the canonical bytes are identical

### Requirement: The placement diff follows RFC 11 Section 6.11
`placementDiff` SHALL compare a layout input with a candidate produced against
it, or with a later layout input. It SHALL match components by stable
identifier. It SHALL place a candidate's block members by the block's transform
composed with each member's pose. Each row SHALL record its owner, read from
the before side's layout input. Against a candidate, each row SHALL also
record its approval class:
- refused for a locked placement
- required for a placement a person or an import adapter owns, under RFC 12's
  default policy
- automatic otherwise

It SHALL list in `copper` the traces, vias, and zones present on one side
only, by identifier, treating a routing candidate's copper as its complete
routing and the input's zones as preserved. It SHALL refuse a candidate
produced against a different layout input.

#### Scenario: The RFC's published diff reproduces
- **WHEN** the diff of the example layout input against the example candidate
  is computed, with the block layout's constraint results as the after side
- **THEN** it equals the RFC's published placement diff, including its content
  hash

#### Scenario: A routing candidate's copper appears
- **WHEN** the example routing candidate is diffed against the layout input it
  ran against
- **THEN** its new trace and via are listed as added and the trace it replaces
  as removed, and the text view says so

#### Scenario: A stale candidate is refused
- **WHEN** a candidate is diffed against a layout input it did not run against
- **THEN** the diff is refused with an error naming both hashes

### Requirement: The change views follow RFC 11 Section 14.4
The text view SHALL print one line per row of a placement diff:
- component lines marked `+`, `-`, or `~`, each prefixed `!` when it requires
  approval and `x` when it is refused
- lines that need a decision first, each group sorted by reference designator
- constraint lines, then finding lines, after the component lines
- positions in exact millimetres and angles in exact degrees

The board text SHALL print a `.kicad_pcb` one fact per line, in this order:
- the outline and copper layers
- each footprint, sorted by reference designator
- each net's routed copper, with a digest of its segments' and vias'
  geometry, widths, and drills
- each zone, with a digest of its outline and settings

The outline SHALL be the extent of the edge cuts with every arc and circle at
its true extremes.

Neither view SHALL call a model, the network, or a CAD tool.

#### Scenario: The RFC's text view reproduces
- **WHEN** the text view of the RFC's published diff is rendered
- **THEN** it equals the example in RFC 11 Section 14.4, line for line

#### Scenario: A change no count shows still changes its line
- **WHEN** a trace's width, a via's position or drill, or a zone's vertex
  changes in a board file
- **THEN** that net's or zone's line changes

#### Scenario: A curved board reports its extent
- **WHEN** a board's edge is a circle or an arc
- **THEN** the outline spans the curve's extremes, not only its stored points

#### Scenario: A moved footprint is one changed line
- **WHEN** one footprint's position changes in a board file
- **THEN** exactly one line of the board text changes
- **AND** reordering the footprints in the file changes no line

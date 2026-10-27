# design-graph-ingest: Delta Spec

## ADDED Requirements

### Requirement: Netlist is the source of truth for parts and connectivity
When the `kicad-cli` netlist export can be produced, the design graph SHALL hold one part per netlist component (hierarchical instances included, a multi-unit part once) and every part pin's `net` SHALL be a name in `nets[]`. Geometry-side data (DNP and BOM-exclusion flags, pin names) SHALL be joined from the schematic by uuid, then by refdes. Net names SHALL have KiCad's `{slash}`-style escapes undone.

#### Scenario: Netlist decides connectivity
- **WHEN** a graph is built from a netlist and the schematic parse
- **THEN** each pin's `net` is the name of the net in `nets[]` that lists that pin, even where the schematic parse names it differently

#### Scenario: Multi-unit part appears once
- **WHEN** the netlist holds one component with several units
- **THEN** the graph holds one part for it

### Requirement: Offline fallback is marked partial
When the netlist cannot be produced (kicad-cli missing, failing or timing out after 60 s), the graph SHALL be built from the schematic parse with one part per refdes, SHALL set `generated.partial` to true, and SHALL record the reason.

#### Scenario: kicad-cli unavailable
- **WHEN** the netlist export fails
- **THEN** the graph is written with `partial: true` and a non-empty `partialReason`

#### Scenario: Bad override is a hard error
- **WHEN** `COPPERHEAD_KICAD_CLI` is set to a path that does not exist and `ingest` runs
- **THEN** it exits 1 naming the path and writes no graph, instead of falling back

### Requirement: Derived classification
Each part SHALL be classed `ic`, `passive`, `discrete`, `connector`, `power` or `mechanical` from its library, footprint, reference prefix and pin count, and the evidence SHALL be kept. Only an exact `Power` library nickname SHALL class a part as `power`.

#### Scenario: Stock power IC
- **WHEN** a part from `Power_Protection` with six pins is classified
- **THEN** it is an `ic`

#### Scenario: Discretes stay out of chips
- **WHEN** an LED, a diode and a crystal are classified
- **THEN** each is `discrete`

### Requirement: Graph freshness covers every sheet
The graph SHALL record a sha256 for every schematic sheet file in the hierarchy. A reader SHALL treat the graph as absent when it is missing, has another version, or when any sheet's hash or the set of sheet files differs.

#### Scenario: Sub-sheet edited
- **WHEN** a sub-sheet is edited after the graph was written
- **THEN** reading the graph for freshness returns nothing

### Requirement: Graph is a gitignored cache
`init` and `ingest` SHALL write identical bytes for an unchanged project and SHALL list `.copperhead/design-graph.json` in the repo's `.gitignore`.

#### Scenario: Init then ingest
- **WHEN** `init` then `ingest` run with no schematic change
- **THEN** the graph file is unchanged and git does not report it

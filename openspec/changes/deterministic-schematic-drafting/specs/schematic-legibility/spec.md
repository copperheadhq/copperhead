# schematic-legibility — Delta Spec

## ADDED Requirements

### Requirement: Subsystem group boxes

Every non-power symbol on a generated sheet SHALL belong to exactly one drawn subsystem group. A group SHALL be a schematic `(rectangle …)` graphic item whose stroke type is `solid` for a functional block or `dash` for an annotation cluster (decoupling bank, boot/reset, test points), paired with a `(text …)` caption positioned inside the rectangle's top band naming the subsystem. Caption text SHALL match a subsystem or component group named in SUBSYSTEMS.md or BOM.md; a caption that matches neither SHALL be reported under the `unlabeled-group` kind, since an invented name labels nothing. Group rectangles SHALL NOT overlap one another, except that a group MAY fully contain a nested group, in which case the innermost containing group owns the symbol. Power-port symbols (`power:` library entries and `PWR_FLAG`) are exempt from group membership.

#### Scenario: Ungrouped symbol is reported

- **WHEN** a symbol's body bounding box lies inside no group rectangle
- **THEN** the checker reports an `ungrouped-symbol` finding naming the refdes, its coordinates, and the nearest group

#### Scenario: Group without a caption is reported

- **WHEN** a group rectangle has no text item inside its top band
- **THEN** the checker reports an `unlabeled-group` finding with the rectangle's coordinates

#### Scenario: Invented caption is reported

- **WHEN** a group rectangle's caption matches no subsystem in SUBSYSTEMS.md and no component group in BOM.md
- **THEN** the checker reports an `unlabeled-group` finding naming the caption, the rectangle's coordinates, and the nearest documented name

#### Scenario: Missing source docs skip caption validation loudly

- **WHEN** SUBSYSTEMS.md or BOM.md is absent, or contains no parseable subsystem or component-group names
- **THEN** caption validation is reported as skipped with that reason rather than passing or failing silently, and the geometric group checks still run

#### Scenario: Overlapping groups are reported

- **WHEN** two group rectangles intersect without one fully containing the other
- **THEN** the checker reports a `group-overlap` finding naming both captions

#### Scenario: Power symbol needs no group

- **WHEN** a `power:GND` symbol sits outside every group rectangle
- **THEN** no `ungrouped-symbol` finding is produced for it

### Requirement: Block-partitioned layout and page sizing

Generated sheets SHALL place groups so that all drawn content lies inside the drawing frame and clear of the title block, on a paper size chosen so the content fills the usable frame area. The checker SHALL resolve the page dimensions from the sheet's `(paper …)` value against a table of standard sizes, compute the usable area as the page minus the frame border and the title-block region, and evaluate both content containment and content utilization against it.

#### Scenario: Content outside the frame is an error

- **WHEN** any symbol, wire, label, or group rectangle extends outside the usable frame area
- **THEN** the checker reports an `out-of-frame` finding at error severity naming the item and the edge it crosses

#### Scenario: Sparse sheet is advised to resize

- **WHEN** content occupies less than the configured utilization threshold of the usable frame area
- **THEN** the checker reports a `low-utilization` finding at advisory severity stating the measured fraction and the next smaller standard paper size that would fit the content

#### Scenario: Unknown paper size skips the page checks

- **WHEN** `(paper …)` names a size absent from the standard-size table and carries no explicit dimensions
- **THEN** the page-relative checks are reported as skipped for that sheet rather than passing silently

### Requirement: Label-driven inter-block connectivity

Connections that leave a group SHALL be made with net labels rather than long wires crossing the sheet. The checker SHALL report a wire segment that crosses a group boundary, or whose length exceeds the configured maximum, as a candidate for replacement by a label pair.

#### Scenario: Cross-sheet wire is advised to become labels

- **WHEN** a wire segment runs from inside one group to inside another
- **THEN** the checker reports a `cross-group-wire` finding naming both groups and the net, suggesting a label pair

#### Scenario: Short local wire is not reported

- **WHEN** a wire segment stays inside one group and is shorter than the configured maximum
- **THEN** no `cross-group-wire` finding is produced

#### Scenario: Overlong wire inside one group is reported

- **WHEN** a wire segment stays inside one group but its length exceeds the configured maximum
- **THEN** the checker reports a `cross-group-wire` finding naming the containing group and the net, suggesting a shorter route or a label pair

### Requirement: Deterministic read-only legibility checker

The checker SHALL be implemented as a read-only module over the existing s-expression parser. It SHALL NOT serialize s-expressions, SHALL NOT modify any file, SHALL make no network calls, and SHALL invoke no language model. It SHALL derive symbol body bounding boxes from the `lib_symbols` graphic items of each instantiated symbol, transformed by the instance's position, rotation, and mirror. It SHALL approximate a text item's extent as `characters × 0.6 × font height` wide by the font height tall: the advance ratio is fixed at 0.6 (a dimensionless fraction of the font height per character), deliberately below the KiCad stroke font's average advance so marginal collisions are missed rather than invented. Every geometric comparison SHALL apply a fixed 0.01 mm tolerance so file-precision noise cannot flip a finding.

#### Scenario: Checker leaves the schematic untouched (AC-16.28)

- **WHEN** the checker runs against a schematic
- **THEN** the file's bytes are unchanged and no subprocess or network call is made

#### Scenario: Clean fixture produces no findings (AC-16.27)

- **WHEN** the checker runs against the well-drafted fixture schematic
- **THEN** it reports zero findings at every severity

### Requirement: Check families and severities

The checker SHALL evaluate these families, each carrying a stable kind identifier: `symbol-overlap`, `text-collision`, `off-grid`, `label-orientation`, `out-of-frame`, `low-utilization`, `crowding`, `ungrouped-symbol`, `unlabeled-group`, `group-overlap`, `cross-group-wire`, `wire-through-symbol`, and `empty-title-block`. Each family SHALL carry a default severity of `error` or `advisory`. The `text-collision` family SHALL test Reference and Value property text, net and hierarchical label text, and free `(text …)` items against symbol body boxes, wire segments, and one another; pin name and pin number text SHALL participate on neither side of the test, matching their exclusion from the body box, and a label SHALL NOT collide with the wire it is attached to. The `off-grid` family SHALL test symbol origins, wire endpoints, and net and hierarchical label positions against the configured grid pitch, and `off-grid` findings SHALL be ordered before every other family in the report, because a repair nudge that leaves the grid silently breaks connectivity. The `crowding` family SHALL report a pair of symbols on the same sheet whose body bounding boxes sit closer, edge to edge, than the configured minimum readable pitch; the finding SHALL name both refdes and state the measured distance against the threshold. `symbol-overlap`, `text-collision`, `off-grid`, `out-of-frame`, `ungrouped-symbol`, `unlabeled-group`, `group-overlap`, `wire-through-symbol`, and `empty-title-block` SHALL default to `error`; `label-orientation`, `low-utilization`, `crowding`, and `cross-group-wire` SHALL default to `advisory`.

#### Scenario: Text over a symbol body is an error

- **WHEN** a symbol's Reference or Value property text box intersects another symbol's body bounding box
- **THEN** a `text-collision` finding is reported at error severity naming both refdes and the overlapping region

#### Scenario: Label text over an unrelated wire is an error

- **WHEN** a net label's text box intersects a wire segment other than the one the label is attached to
- **THEN** a `text-collision` finding is reported at error severity naming the label and the crossed wire's net

#### Scenario: Pin text never collides

- **WHEN** a symbol's pin name or pin number text overlaps that symbol's body, a wire, or other text
- **THEN** no `text-collision` finding is produced for it

#### Scenario: Off-grid wire endpoint is an error

- **WHEN** a wire endpoint is not a multiple of 1.27mm on either axis
- **THEN** an `off-grid` finding is reported at error severity with the coordinate and the nearest on-grid point

#### Scenario: Off-grid symbol origin and label position are errors

- **WHEN** a symbol origin or a net label position is not a multiple of the grid pitch on either axis
- **THEN** an `off-grid` finding is reported at error severity for each, with the coordinate and the nearest on-grid point

#### Scenario: Grid findings lead the report (AC-16.29)

- **WHEN** a sheet has both `off-grid` findings and findings from other families
- **THEN** the `off-grid` findings appear before every other family in the report

#### Scenario: Crowded neighbours are advised

- **WHEN** two symbols' body bounding boxes sit closer edge to edge than the configured minimum readable pitch without intersecting
- **THEN** a `crowding` finding is reported at advisory severity naming both refdes and the measured distance against the threshold

#### Scenario: Rotated label where horizontal fits is advisory

- **WHEN** a label is drawn at 90 or 270 degrees and the same label drawn horizontally would collide with nothing
- **THEN** a `label-orientation` finding is reported at advisory severity

#### Scenario: Wire through a symbol body is an error

- **WHEN** a wire segment crosses a symbol's body bounding box without terminating on one of that symbol's pins
- **THEN** a `wire-through-symbol` finding is reported at error severity

#### Scenario: Empty title block is an error

- **WHEN** the sheet's title block has an empty title, revision, or date field
- **THEN** an `empty-title-block` finding is reported at error severity listing the empty fields

### Requirement: Finding format and bounded output

Each finding SHALL carry `{kind, severity, sheet, at: {x, y}, refs, detail}`, where `detail` states the defect and the concrete fix. `refs` SHALL be populated for every finding with the entities involved, and is not limited to refdes: symbol-anchored findings carry the affected refdes, group-anchored findings carry the group captions (`group-overlap` carries both), `empty-title-block` carries the names of the empty fields, and page-level findings (`low-utilization`, and `out-of-frame` when no single item is at fault) carry the sheet name. Pairwise families SHALL report each unordered pair at most once. The checker SHALL cap findings per family per sheet at a configured limit and SHALL append an explicit count of suppressed findings, so a single crowded cluster cannot emit a quadratic report or silently hide the remainder.

#### Scenario: Pair reported once

- **WHEN** symbols R1 and R2 overlap each other
- **THEN** exactly one `symbol-overlap` finding is produced, naming both refdes

#### Scenario: Non-symbol findings carry refs

- **WHEN** a `group-overlap`, an `empty-title-block`, and a `low-utilization` finding are produced
- **THEN** their `refs` name the two group captions, the empty field names, and the sheet name respectively

#### Scenario: Truncation is stated, not silent

- **WHEN** a family produces more findings on one sheet than the configured cap
- **THEN** the output contains the capped findings followed by a line stating how many were suppressed

### Requirement: Thresholds and severity are configurable

Thresholds (grid pitch, minimum readable symbol pitch, utilization fraction, maximum wire length, per-family finding cap) and per-family severity overrides SHALL be readable from an optional `legibility` block in `.copperhead/config.json`, with documented defaults that apply when the block is absent. Setting a family's severity to `off` SHALL disable that family.

#### Scenario: Defaults apply without configuration

- **WHEN** no `legibility` block is present in the config
- **THEN** the checker runs every family at its default severity and documented default thresholds

#### Scenario: Family can be disabled (AC-16.30)

- **WHEN** the config sets `legibility.severity.crowding` to `off`
- **THEN** no `crowding` findings are produced and the family is listed as disabled in the report

### Requirement: Every sheet in a hierarchy is checked

The checker SHALL walk the full sheet hierarchy from the root schematic, evaluate every sheet, and attribute each finding to the sheet it came from. Page-relative checks SHALL use each sheet's own `(paper …)` value.

#### Scenario: Sub-sheet finding is attributed

- **WHEN** a defect exists only on a sub-sheet
- **THEN** the finding names that sub-sheet, and the root sheet's own findings are unaffected

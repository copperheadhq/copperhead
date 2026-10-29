# schematic-hierarchy — Delta Spec

## ADDED Requirements

### Requirement: Sheet mode selection

The intent SHALL accept an optional `hints.sheets` value of `flat`, `hierarchical`, or `auto`; absent means `auto`. `flat` SHALL draft one sheet exactly as before this change. `hierarchical` SHALL draft one sub-sheet per group under a root sheet, and SHALL fall back to `flat` with a report note when the intent has fewer than two groups. `auto` SHALL draft hierarchically when the intent has two or more groups and the flat draft's chosen paper is larger than A3, and flat otherwise. Selection SHALL be deterministic: the same intent SHALL select the same mode on every run. Any other value SHALL be a validation finding naming the field and the accepted values.

#### Scenario: Small design stays flat (AC-16.65)

- **WHEN** an intent without `hints.sheets` drafts flat onto A3 or smaller
- **THEN** the output is a single sheet byte-identical to the output before this change

#### Scenario: Large multi-group design goes hierarchical (AC-16.66)

- **WHEN** an intent without `hints.sheets` has two or more groups and its flat draft would need A2 or larger
- **THEN** the drafter writes a root sheet and one sub-sheet per group, and the report states the hierarchical mode and why it was selected

#### Scenario: Explicit hint overrides auto

- **WHEN** `hints.sheets` is `flat` on a design that `auto` would split, or `hierarchical` on a design that `auto` would keep flat
- **THEN** the requested mode is drafted

#### Scenario: Invalid hint is a finding

- **WHEN** `hints.sheets` is any value other than `flat`, `hierarchical`, or `auto`
- **THEN** validation fails naming `hints.sheets` and the accepted values, and no file is written

### Requirement: One sub-sheet per group

In hierarchical mode each group SHALL be drafted onto its own sub-sheet by the same placement, routing, and label rules as a flat sheet, restricted to that group's parts and the power symbols its pins need. Each sub-sheet SHALL choose its own paper size. Its title block SHALL name the group, and it SHALL keep that group's captioned box, so the legibility checker's group rules hold on every sheet. Sub-sheet files SHALL be written beside the root schematic as `<root-basename>-<group-slug>.kicad_sch`, where the slug is the group name lowercased with every run of characters outside `[a-z0-9]` replaced by `-`. Two groups whose slugs collide SHALL be a validation finding naming both groups.

#### Scenario: Group parts land on their own sheet (AC-16.67)

- **WHEN** a hierarchical draft succeeds
- **THEN** every non-power part appears on exactly one sub-sheet, the sub-sheet of its group, and no part appears on the root sheet

#### Scenario: Colliding sheet file names are refused

- **WHEN** two group names slugify to the same file name
- **THEN** validation fails naming both groups, and no file is written

### Requirement: Cross-sheet connectivity through hierarchical pins

A signal net whose endpoints span more than one group SHALL be connected through the hierarchy:
- Each sub-sheet it touches SHALL carry at least one `hierarchical_label` with the net's name.
- The sheet symbol for that sub-sheet on the root SHALL carry exactly one sheet pin of the same name.
- On the root, the sheet pins of that net SHALL be joined either by wires or by stubs ending in local labels of the net's name.

Such a net SHALL carry a hierarchical label on each sheet it touches even when that sheet's portion of the net is fully wired. On that sheet, every label of the net SHALL be hierarchical, so no local label can split it.

A signal net confined to one group SHALL use only local labels, or no label at all. Power and ground nets SHALL remain power symbols on every sheet and SHALL have no sheet pins.

The label and pin shape SHALL follow the electrical types of the net's pins on that sheet, by the same rule flat drafting uses for global label shapes.

#### Scenario: Shared signal gets a label and a pin (AC-16.68)

- **WHEN** net `SDA` has endpoints in groups `MCU` and `Sensors`
- **THEN** both sub-sheets carry a `hierarchical_label "SDA"`, both sheet symbols carry a pin `"SDA"`, and the root connects those two pins

#### Scenario: Fully wired in-sheet portion still exits the sheet

- **WHEN** a cross-group net's endpoints on one sub-sheet are all joined by wires
- **THEN** that wired run still carries a hierarchical label, and no local label of that name exists on that sheet

#### Scenario: Local net stays local

- **WHEN** a signal net has all its endpoints in one group
- **THEN** its sub-sheet carries no hierarchical or global label for it, and its sheet symbol has no pin for it

#### Scenario: Power nets need no sheet pins

- **WHEN** a rail or ground net has endpoints in several groups
- **THEN** each sub-sheet draws power symbols for that net, and no sheet pin or hierarchical label is created for it

### Requirement: Readable root sheet

The root sheet SHALL hold exactly one sheet symbol per group, in the drafting group order, sized to fit its pins and name, placed on the grid inside the frame and clear of the title block, and SHALL hold nothing but the sheet symbols, their connections, and the title block. Each sheet pin SHALL sit on the side of its symbol that faces the symbol it connects to, and pins on each side SHALL be ordered to reduce crossings. A wire SHALL join two sheet pins only when a route between them is available that crosses no sheet symbol and passes through no other net's pin or wire; otherwise each pin SHALL get a short stub ending in a local label of the net's name. The root sheet SHALL satisfy the same legibility gates (grid, frame, overlap, merged-net refusal) as a flat sheet.

#### Scenario: Root holds only sheet symbols (AC-16.69)

- **WHEN** a hierarchical draft succeeds
- **THEN** the root sheet contains one sheet symbol per group and no part symbols, and every sheet pin is either wired to another pin of its net or ends in a local label of its net

#### Scenario: Unroutable pair falls back to labels

- **WHEN** the route between two sheet pins of one net would cross a sheet symbol or touch another net
- **THEN** both pins end in stubs with local labels of the net's name, and no wire joins them

### Requirement: Hierarchical output is netlist-equivalent and deterministic

A hierarchical draft SHALL implement exactly the intent's connectivity. When exported through `kicad-cli sch export netlist` from the root sheet, the pin partition SHALL equal the intent's, with no pins joined that the intent keeps apart and none separated that it joins. The drafter SHALL refuse to write any file, as it does for a merged net in a flat sheet, when:
- two nets would merge on any sheet;
- a hierarchical label has no matching sheet pin;
- a sheet pin has no matching hierarchical label.

The output SHALL be byte-for-byte deterministic:
- Every UUID SHALL be derived from a semantic path that includes the sheet.
- Symbol instance paths SHALL be `/<root-uuid>/<sheet-uuid>`.
- Sheet symbols SHALL carry page numbers 2 to N in group order.
- Only the root sheet SHALL carry `sheet_instances`, with the root as page 1.

#### Scenario: Round trip matches the intent (AC-16.70)

- **WHEN** a hierarchical draft is exported to a netlist with `kicad-cli` from its root
- **THEN** the pin partition equals the intent's, with zero pin groups lost and zero gained

#### Scenario: Deterministic multi-file output

- **WHEN** the same intent is drafted hierarchically twice
- **THEN** every written file is byte-identical across the two runs

#### Scenario: ERC has no hierarchy mismatches

- **WHEN** ERC runs on a hierarchical draft
- **THEN** it reports no hierarchical-label, sheet-pin, or multiple-net-name violations

### Requirement: Multi-file drafting surfaces

The draft report SHALL state the mode, the reason for it, and every sheet written with its paper size. The CLI `draft schematic` command and the `draft_schematic` tool SHALL write all of the following:
- the root sheet;
- every sub-sheet;
- the vendored libraries and the project table, exactly as for a flat draft.

A re-draft SHALL delete a previously drafted sub-sheet the new draft no longer references, but only when the old root referenced it as a sheet and the file carries the drafter's generator mark. Any other file SHALL be left in place.

Geometry edits SHALL be refused on drafted sub-sheets exactly as on a drafted root sheet. The create pipeline's staleness probe SHALL compare every drafted file, not only the root.

#### Scenario: Report lists every sheet (AC-16.71)

- **WHEN** a hierarchical draft succeeds
- **THEN** the report names the root and each sub-sheet file with its group and paper size

#### Scenario: Stale sub-sheet is removed, foreign file is kept

- **WHEN** a re-draft drops a group, or switches from hierarchical to flat
- **THEN** the dropped group's previously drafted sub-sheet is deleted, and a file of the same name that the drafter did not generate is left untouched

#### Scenario: Sub-sheet edits are refused in drafting mode

- **WHEN** the agent calls `edit_file` on a drafted sub-sheet
- **THEN** the call is refused exactly as it is for the drafted root sheet

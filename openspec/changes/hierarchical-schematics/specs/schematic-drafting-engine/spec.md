# schematic-drafting-engine: Delta Spec

## MODIFIED Requirements

### Requirement: Netlist-intent IR

The drafting engine SHALL accept a versioned netlist-intent document (`schematic.intent.json`) as its only input: parts (lib_id, refdes, value, optional footprint), connections (net name to a list of refdes.pin endpoints), group assignments naming a subsystem per non-power part, declared no-connects (a list of refdes.pin entries), optional net-kind declarations (`power`, `ground`, `signal`), and optional hints (port direction, group order, paper size, hierarchy mode: `"flat"` or `"hierarchical"`). The IR SHALL contain no coordinates. The engine SHALL treat the IR as the single source of drafting truth: re-drafting the same IR SHALL fully regenerate the emitted file set, whether that set is one flat sheet or a top sheet plus child sheets.

#### Scenario: IR carries intent, not geometry

- **WHEN** a valid IR is drafted
- **THEN** every symbol position, wire, label, power flag, and no-connect marker in the output is computed by the engine, and no coordinate from the IR is echoed into the file

#### Scenario: IR version is checked

- **WHEN** an IR declares a schema version the engine does not support
- **THEN** drafting fails with a message naming the supported version, and no file is written

#### Scenario: Re-draft regenerates the whole file set (AC-17.6)

- **WHEN** the same IR is drafted hierarchically, committed, and drafted again
- **THEN** `git diff` over the top sheet and every child sheet is empty

### Requirement: Local wiring policy with reserved channels

The engine SHALL draw wires for nets that stay local: all endpoints within one group, at most four endpoints, and within a configured distance budget, routed orthogonally with junctions synthesized where three or more wire ends meet. Idiom micro-templates (decoupling rows, pull-ups, crystal flanking) MAY draw their internal multi-point wires as part of the template. All other connectivity, including every inter-group connection, SHALL use labels placed horizontal wherever a horizontal label fits: net labels in flat mode, and in hierarchical mode hierarchical labels on child sheets for every cross-group net, matched by sheet pins on the top sheet. In-group nets on a child sheet keep flat mode's net-label convention. The engine SHALL reserve wiring channels between placement columns and route only within them, so no drawn wire ever crosses a symbol body, and drafted sheets SHALL satisfy the schematic-legibility gating families by construction in the common case.

#### Scenario: Local three-endpoint net is wired

- **WHEN** a voltage divider's centre tap (R1.2, R2.1, U1.3) stays within one group inside the distance budget
- **THEN** the drafted sheet wires the three endpoints with a junction rather than three floating labels

#### Scenario: Inter-group connection uses labels

- **WHEN** the IR connects a pin in group "MCU" to a pin in group "Power" and the design drafts flat
- **THEN** the drafted sheet carries a matching net label at each pin and no wire between the groups

#### Scenario: Cross-group net becomes a hierarchical label pair

- **WHEN** the IR connects a pin in group "MCU" to a pin in group "Power" and the design drafts hierarchically
- **THEN** each child sheet carries a hierarchical label for the net in its stub column, and the top sheet carries a matching sheet pin on each group's sheet symbol

#### Scenario: Wires never cross symbol bodies

- **WHEN** any IR is drafted
- **THEN** the legibility checker's `wire-through-symbol` family reports zero findings on the output

#### Scenario: Drafted output passes the legibility gate (AC-16.3)

- **WHEN** a Tier C reference IR is drafted
- **THEN** the legibility checker reports zero error-severity findings on the output

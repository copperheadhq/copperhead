# schematic-drafting-engine — Delta Spec

## ADDED Requirements

### Requirement: Netlist-intent IR

The drafting engine SHALL accept a versioned netlist-intent document (`schematic.intent.json`) as its only input: parts (lib_id, refdes, value, optional footprint), connections (net name to a list of refdes.pin endpoints), group assignments naming a subsystem per part, declared no-connects (a list of refdes.pin entries), optional net-kind declarations (`power`, `ground`, `signal`), and optional hints (port direction, group order, paper size). The IR SHALL contain no coordinates. The engine SHALL treat the IR as the single source of drafting truth: re-drafting the same IR SHALL fully regenerate the sheet.

#### Scenario: IR carries intent, not geometry

- **WHEN** a valid IR is drafted
- **THEN** every symbol position, wire, label, power flag, and no-connect marker in the output is computed by the engine, and no coordinate from the IR is echoed into the file

#### Scenario: IR version is checked

- **WHEN** an IR declares a schema version the engine does not support
- **THEN** drafting fails with a message naming the supported version, and no file is written

### Requirement: IR validation fails structured and early

The engine SHALL validate the IR before any placement: lib_ids must resolve, every referenced pin must exist on its symbol, every net must have at least two endpoints, every non-power part must belong to exactly one group present in SUBSYSTEMS.md, a pin declared no-connect must exist and must appear in no net, and the IR's parts SHALL be cross-checked against BOM.md (refdes present, value matching), so a transcription slip fails validation immediately rather than surfacing later at the drift gate. Validation SHALL also cover the field types the engine and emitter dereference (part fields, net kind, endpoint strings, `noConnect`, `hints.*`), so type-confused-but-valid JSON comes back as findings rather than a TypeError surfaced as an opaque tool error; SHALL refuse a net name containing a quote, backslash, or control character, since the name is embedded verbatim in the generated power-symbol source where such a character corrupts the emitted file; and SHALL refuse two power-class nets whose names sanitize to the same generated-symbol token, since they would share one `lib_id` and quietly merge their rails. Validation SHALL also refuse a part resolving to a multi-unit library symbol: the engine places single instances only, and a multi-unit symbol's units share symbol-space pin coordinates, so drafting one would overlay unrelated pins on one point and silently merge their nets. Validation SHALL likewise refuse a part resolving to a power-port library symbol (`power:GND`, `power:+3V3`, `power:PWR_FLAG`): the engine supplies those itself, drawing one per pin of every power-class net and synthesizing PWR_FLAG where such a net has no driver, so a model-authored one is redundant and the placement passes discard it. Refused rather than dropped, because a silent drop reported `ok` with the part absent from the sheet, from its own group's member list, and from the report's notes, leaving the model no signal that its mental model was wrong. No IR that passes validation therefore contains a power-port part at all; the "non-power part" qualifier on the group rule above describes which parts the group check itself examines, since a power-port part is refused by this rule before the group rule could apply. Validation failures SHALL be reported as a numbered finding list in the same shape as `verify_symbols` output, and a failed draft SHALL leave any existing schematic untouched.

#### Scenario: Unknown pin is rejected (AC-16.6)

- **WHEN** the IR connects `U1.99` and the resolved symbol has no pin 99
- **THEN** drafting fails with a numbered finding naming U1, pin 99, and the symbol's actual pin range, and the previous schematic file is unchanged

#### Scenario: BOM mismatch is rejected at validation (AC-16.7)

- **WHEN** the IR lists a part whose refdes is absent from BOM.md or whose value differs from BOM.md's
- **THEN** validation fails naming the refdes and both values, before any placement runs

#### Scenario: Ungrouped part is rejected

- **WHEN** a non-power part has no group assignment
- **THEN** validation fails naming the refdes and the available groups from SUBSYSTEMS.md

#### Scenario: Power-port part is rejected

- **WHEN** the IR lists a part whose lib_id resolves to a power-port symbol (for example `power:GND`)
- **THEN** validation fails naming the refdes and directing the fix to `nets` (and `kind` where the inferred class is wrong), because the engine draws power symbols per pin of every power-class net itself

#### Scenario: Contradictory no-connect is rejected

- **WHEN** a pin is declared no-connect and also appears as a net endpoint
- **THEN** validation fails naming the pin and the conflicting net

#### Scenario: Type-confused fields are findings, not crashes

- **WHEN** the IR is valid JSON with a wrong-typed field the engine dereferences (a numeric `group`, a string `hints.groupOrder`, a string `noConnect`, a non-string net endpoint)
- **THEN** validation fails with a numbered finding naming the field and the expected shape, and no TypeError reaches the tool layer

#### Scenario: Multi-unit symbol is refused

- **WHEN** the IR names a part whose library symbol defines more than one unit (an opamp, a gate pack)
- **THEN** validation fails naming the part and the reason, before any placement runs

#### Scenario: Undrawable and colliding net names are refused

- **WHEN** a net name contains a quote, backslash, or control character, or two power-class net names sanitize to the same generated-symbol token
- **THEN** validation fails naming the offending net name(s), before any placement runs

### Requirement: Deterministic power-net recognition

The engine SHALL classify a net as a power rail or ground by a stated deterministic rule: a net is power-class when it touches any pin whose library electrical type is `power_in` or `power_out`, or when the IR declares its kind; an IR declaration SHALL override the inference. Ground-class nets orient their symbols down, all other power-class nets up. The draft report SHALL list every net's resolved class so a misclassification is visible and correctable through the IR.

#### Scenario: Odd rail name is still recognized

- **WHEN** a net named `VBAT` connects to an IC's `power_in` pin
- **THEN** it is classified power-class without any IR declaration and is reduced to per-pin power symbols

#### Scenario: IR override wins

- **WHEN** the IR declares a net's kind as `signal` although it touches a `power_in` pin
- **THEN** the engine routes it as a signal net and the draft report notes the override

### Requirement: Reductions precede layout

Before placement the engine SHALL: replace power-class nets with per-pin power symbols (rails oriented up, grounds down, at uniform heights); classify decoupling capacitors (a two-pin capacitor between a power-class net and ground) and place them as a row beside their associated IC, ownership resolved deterministically (same group first, then most shared connections, then refdes order); assign connectors to sheet edges honoring direction hints; and partition remaining symbols by their IR group into the drafting standard's captioned group boxes.

#### Scenario: Power nets are never routed (AC-16.8)

- **WHEN** the IR contains a power-class net reaching twelve pins
- **THEN** the drafted sheet contains one power symbol per reached pin and no wire spanning those pins

#### Scenario: Decoupling row

- **WHEN** the IR contains four 100nF capacitors each between VCC and GND, associated with U1 by shared nets and group
- **THEN** the drafted sheet places them as a single row adjacent to U1's group position with a rail label

#### Scenario: Shared rail resolves ownership deterministically

- **WHEN** a rail feeds two ICs in one group and a decoupling capacitor could belong to either
- **THEN** ownership is resolved by the stated tie-break and is identical on every re-draft

### Requirement: Every gate failure is resolvable through the IR

For every defect the downstream gates can raise (ERC, the legibility checker), the engine SHALL provide either an IR field or a deterministic synthesis rule that resolves it, so the repair loop can always act without geometry edits. In particular: a pin declared no-connect SHALL be emitted as a `(no_connect …)` marker at that pin's position, and a power-class net with no `power_out` driver SHALL receive a synthesized `PWR_FLAG` at a deterministic location, so ERC's undriven-power check passes on drafted output.

#### Scenario: Undriven rail gets a PWR_FLAG (AC-16.9)

- **WHEN** a power-class net is sourced only by a connector pin (no `power_out` driver)
- **THEN** the drafted sheet carries exactly one synthesized `PWR_FLAG` on that net and ERC reports no undriven-power violation

#### Scenario: Declared no-connect passes ERC (AC-16.10)

- **WHEN** the IR declares `U1.8` no-connect
- **THEN** the drafted sheet carries a `(no_connect …)` marker at that pin and ERC reports no unconnected-pin violation for it

### Requirement: Deterministic grid-native placement

The engine SHALL compute all geometry in integer multiples of the 1.27mm grid: groups tiled left to right along signal flow, flow order derived from the directed pin-type graph (outputs toward inputs) with SUBSYSTEMS.md declaration order as the deterministic tie-break; each group box sized from the summed extents of everything it must hold, symbol bodies plus their power symbols, decoupling rows, refdes and value text slots, and label clearance; symbols within a group placed by longest-path layering with barycenter ordering. Identical IR SHALL produce identical placement on every run and every machine; the engine SHALL use no randomness, no wall-clock input, and no environment-dependent ordering.

#### Scenario: Placement is reproducible (AC-16.1)

- **WHEN** the same IR is drafted twice on machines with identical vendored symbol sources
- **THEN** the two `.kicad_sch` files are byte-identical

#### Scenario: Pins are on-grid by construction (AC-16.2)

- **WHEN** any IR is drafted
- **THEN** every symbol origin and every wire endpoint lies on the 1.27mm grid, and the legibility checker's `off-grid` family reports zero findings

#### Scenario: Group boxes contain their annotations

- **WHEN** a group holds an IC with a decoupling row and per-pin power symbols
- **THEN** the group rectangle encloses the symbols, the row, the power symbols, and all refdes/value text, with no `out-of-frame` or `ungrouped-symbol` finding

### Requirement: Local wiring policy with reserved channels

The engine SHALL draw wires for nets that stay local: all endpoints within one group, at most four endpoints, and within a configured distance budget, routed orthogonally with junctions synthesized where three or more wire ends meet. Idiom micro-templates (decoupling rows, pull-ups, crystal flanking) MAY draw their internal multi-point wires as part of the template. All other connectivity, including every inter-group connection, SHALL use net labels placed horizontal wherever a horizontal label fits. The engine SHALL reserve wiring channels between placement columns and route only within them, so no drawn wire ever crosses a symbol body, and drafted sheets SHALL satisfy the schematic-legibility gating families by construction in the common case.

#### Scenario: Local three-endpoint net is wired

- **WHEN** a voltage divider's centre tap (R1.2, R2.1, U1.3) stays within one group inside the distance budget
- **THEN** the drafted sheet wires the three endpoints with a junction rather than three floating labels

#### Scenario: Inter-group connection uses labels

- **WHEN** the IR connects a pin in group "MCU" to a pin in group "Power"
- **THEN** the drafted sheet carries a matching net label at each pin and no wire between the groups

#### Scenario: Wires never cross symbol bodies

- **WHEN** any IR is drafted
- **THEN** the legibility checker's `wire-through-symbol` family reports zero findings on the output

#### Scenario: Drafted output passes the legibility gate (AC-16.3)

- **WHEN** a Tier C reference IR is drafted
- **THEN** the legibility checker reports zero error-severity findings on the output

### Requirement: Alignment, symmetry, and balance

After placement and wiring, the engine SHALL run a deterministic alignment pass so the sheet reads as deliberately drawn: symbols within a placement column SHALL share a common axis; gaps between siblings (column members, decoupling-row capacitors, power symbols on one rail) SHALL be uniform; a chain of two-pin passives between aligned endpoints SHALL be placed collinearly so its wires run straight with zero bends; recognized paired structures (crystal load capacitors, differential or push-pull pairs) SHALL be placed mirror-symmetrically about their shared axis; group contents SHALL be centered within their group box; and groups SHALL be distributed so content sits balanced within the usable frame rather than packed to one side. Every alignment move SHALL preserve the grid, connectivity, and all gating invariants.

#### Scenario: Straight-through passives (AC-16.31)

- **WHEN** a series RC between two aligned pins is drafted within one group
- **THEN** both passives sit on the shared axis and every wire in the chain has zero bends

#### Scenario: Uniform sibling spacing

- **WHEN** a decoupling row of four capacitors is drafted
- **THEN** the three gaps between adjacent capacitors are equal, and their refdes/value texts sit at a common height

#### Scenario: Symmetric pairs

- **WHEN** a crystal with two load capacitors is drafted
- **THEN** the capacitors mirror each other about the crystal's axis at equal offsets

#### Scenario: Balanced sheet

- **WHEN** any Tier C reference IR is drafted
- **THEN** the content bounding box's center lies within the configured balance tolerance of the usable frame's center

### Requirement: Drafting entry points

The system SHALL expose the engine as `copperhead draft schematic` (IR in, schematic and report out), deterministic, LLM-free, and network-free under the same contract class as `check`. The draft report SHALL state the groups placed, the wire and label counts, every net's resolved power class, any synthesized `PWR_FLAG`s, and SHALL embed the legibility checker's findings and the score for the freshly drafted sheet, so a draft, its check, and its score cost one call rather than three.

#### Scenario: draft is deterministic and offline

- **WHEN** `copperhead draft schematic` runs
- **THEN** no language-model call and no network request is made

#### Scenario: Report embeds check and score (AC-16.11)

- **WHEN** a draft succeeds
- **THEN** the report includes the checker's findings (or a clean statement) and the score composite with its breakdown, without separate tool calls

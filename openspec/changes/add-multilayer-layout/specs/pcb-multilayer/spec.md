## ADDED Requirements

### Requirement: Canonical copper stack
The IR SHALL expose the board's copper layers as a stack ordered front to back, `F.Cu`, `In1.Cu` … `InN.Cu`, `B.Cu`, derived from the canonical layer names and independent of the layer numbers the file carries (KiCad's legacy numbering and the KiCad 10 numbering both map to the same stack). Every consumer of copper layers (DSN and ORP emitters, SES and ORS importers, connectivity, geometry, metrics, the renderer, engine adapters) SHALL read the stack from the IR's stack helper. A board with more than six copper layers, or with a copper layer whose name is none of the canonical names, SHALL be refused at pre-flight with `preflight.stack` naming the layer.

#### Scenario: Both numberings give one stack
- **WHEN** a four-layer board with the legacy numbering (`In1.Cu` 1, `In2.Cu` 2, `B.Cu` 31) and one with the KiCad 10 numbering (`B.Cu` 2, `In1.Cu` 4, `In2.Cu` 6) are imported
- **THEN** both report the stack `F.Cu, In1.Cu, In2.Cu, B.Cu`, and a two-layer board of either numbering reports `F.Cu, B.Cu`

#### Scenario: Unsupported stack is refused
- **WHEN** an eight-layer board, or a board whose copper layer is named `Signal3`, is imported and verified
- **THEN** pre-flight fails with `preflight.stack` naming the layer or the count, the run is `REFUSE`, and no engine is invoked

### Requirement: Through vias span the stack
A via SHALL connect every copper layer between its two end layers in stack order. On this change every via SHALL span the whole stack (outer layer to outer layer); a via whose ends are inner layers, or the same layer, or a layer not in the stack, SHALL fail the routing gate with `geom.via-layers`. An engine result carrying a via whose ends are not the outer layers SHALL make the invocation `INVALID_OUTPUT` naming the via and its net.

#### Scenario: Inner-layer copper connects through a via
- **WHEN** a four-layer board carries a net whose copper runs on `F.Cu`, drops through a through via, continues on `In1.Cu`, and reaches its second pad through another via
- **THEN** the connectivity checker reports the net complete and `completion_rate` counts it

#### Scenario: Buried via is refused
- **WHEN** a golden four-layer board carries a seeded via spanning `In1.Cu` to `In2.Cu`
- **THEN** verification reports `geom.via-layers` on that via's net, the routing gate fails, and `check` ends `REFUSE`

### Requirement: Fabrication profile by copper count
Fabrication profiles `jlcpcb-4layer` and `jlcpcb-6layer` SHALL exist beside `jlcpcb-2layer`, vendored from the same source with the per-layer-count clearance, track, and via values and the same provenance block and critical DRC list. When no profile is configured, a board SHALL take the profile whose `layers` equals its stack length. A configured profile whose `layers` differs from the board's stack SHALL be refused at pre-flight with `preflight.profile`.

#### Scenario: Default profile follows the stack
- **WHEN** a six-layer board is verified with no profile configured
- **THEN** `jlcpcb-6layer` is used and the evidence names it

#### Scenario: Wrong profile is refused, not applied
- **WHEN** a four-layer board is verified with `pcb.profile: jlcpcb-2layer` configured
- **THEN** pre-flight fails with `preflight.profile` naming both layer counts and no engine is invoked

### Requirement: Layer-aware routing strategy and scoring
The staged routing plan SHALL hand every router the board's layer count and, on four and six layers, a default layer strategy of alternating preferred directions on the inner layers (horizontal on `In1.Cu`, vertical on `In2.Cu`, and so on) with no preference on the outer layers, overridable by the intent file's `routing.layers` entries. Scoring on four and six layers SHALL use `default-low-speed-4-layer` and `default-low-speed-6-layer`, the two-layer weights without the bottom-layer return-path terms and renormalised, and the return-path checker SHALL emit its metrics only on two-layer boards.

#### Scenario: kicad-tools gets the board's layer count
- **WHEN** a six-layer board is routed with `router-kicad-tools`
- **THEN** the invocation carries `--layers 6` and the provenance records it

#### Scenario: Intent overrides the default directions
- **WHEN** the intent file declares `routing.layers: In1.Cu: vertical`
- **THEN** the DSN's `layer_rule` for `In1.Cu` prefers vertical and `In2.Cu` keeps the default

### Requirement: Renders show every copper layer
The SVG renderer SHALL draw every layer of the stack, back to front, with a distinct colour per layer and a legend entry for each layer that carries copper, so a four-layer candidate's inner copper is visible in the bench galleries and in evidence.

#### Scenario: Inner copper is drawn
- **WHEN** a four-layer candidate with copper on `In1.Cu` is rendered
- **THEN** the SVG contains that copper in the `In1.Cu` colour and the legend lists `In1.Cu`

### Requirement: Multilayer golden boards and suites
The golden corpus SHALL include `four-layer`, `six-layer`, and `via-span` cases generated with the KiCad 10 numbering and `expected.json` like the two-layer cases; `bench/suites/multilayer-microboards.json` SHALL run them through routing with every wrapped router, and `bench/suites/pcbench-4layer.json` SHALL list the permissively licensed four-layer PCBench boards that upgrade and pass KiCad 10 DRC, run as track B and reported separately from the two-layer numbers.

#### Scenario: Multilayer suite reproduces its expectations
- **WHEN** `copperbench run bench/suites/multilayer-microboards.json` runs with `router-freerouting` and `router-kicad-tools`
- **THEN** `four-layer` and `six-layer` end PASS or PARTIAL with the cycles recorded, `via-span` ends REFUSE with `geom.via-layers`, and every two-layer suite's numbers are unchanged

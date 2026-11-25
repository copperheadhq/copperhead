## ADDED Requirements

### Requirement: Critical relationship classes

The harness SHALL classify connections and part sets into critical relationships of these classes: `mechanical`, `rf-keepout`, `supply-decoupling`, `bootstrap`, `config`, `crystal`, `hot-loop`, `output-chain`, `aggressor`, `sensitive`, `channel`, `thermal`, `signal`, `low`.

Each relationship SHALL record:
- its class and parts;
- where applicable, its pins, order, maximum distance, maximum loop area and minimum distance;
- its severity, source (`user`, `datasheet`, `rule`, `model`), confidence and citation.

Classification SHALL use:
- **Pin functions**, falling back to net names.
- **Part classes:** reference prefix and footprint library.
- **Topology.** For example:
  - a capacitor between a supply-pin net and ground is `supply-decoupling`;
  - a capacitor between a `BST`/`BOOT` pin and an output pin is `bootstrap`;
  - an IC with a `SW`/`LX`/`PH` pin or net and an inductor on it is a switching `hot-loop`;
  - an inductor on an amplifier output followed by a capacitor or connector is an `output-chain`.

Source authority SHALL be `user` over `datasheet` over `rule` over `model`. Rule relationships are soft, and model relationships have confidence at most 0.7 and are never hard. Every relationship SHALL become a registry constraint that the checker verifies.

#### Scenario: A decoupling capacitor is recognised
- **WHEN** a board has an IC pin named `VDD` on net `+3V3` and a capacitor between `+3V3` and `GND` within 3 mm of that pin
- **THEN** a `supply-decoupling` relationship names the capacitor, the IC and the pin, with source `rule` and severity `soft`

#### Scenario: A buck converter loop is recognised
- **WHEN** a board has a regulator with a pin named `SW`, an inductor on the `SW` net and an input capacitor between `VIN` and `GND`
- **THEN** a `hot-loop` relationship names the regulator, the inductor and the input capacitor in loop order

### Requirement: Current loop evaluator

The intent checker SHALL evaluate `layout.emc.hot-loop.<id>` constraints. It SHALL report the area of the polygon through the loop's pad centres in loop order as `loop_area_mm2`. It SHALL emit `intent.emc.hot-loop` when a maximum is given and exceeded, gating when the constraint is hard.

#### Scenario: A distant input capacitor enlarges the loop
- **WHEN** the `buck-hot-loop` microboard places its input capacitor 12 mm from the regulator under a 20 mm² maximum
- **THEN** `intent.emc.hot-loop` reports the measured area above 20 mm², and the fixed variant reports none

### Requirement: Isolation, channel, RF and crystal edge evaluators

The intent checker SHALL evaluate:
- `layout.emc.isolation.<id>`: courtyard distance between noisy and sensitive sets;
- `layout.emc.channel.<id>`: courtyard distance between left and right channel groups;
- `layout.emc.edge-distance.<ref>`: courtyard distance from the board edge and connectors;
- `layout.rf.edge.<ref>`: the antenna side within 1 mm of the edge, and the clearance region free of other copper and courtyards.

Each SHALL report its measured value as a metric, and SHALL emit its diagnostic when a number is given and violated.

#### Scenario: A crystal near the edge is flagged
- **WHEN** the `noisy-sensitive` microboard places a crystal 1 mm from the edge under a 3 mm edge distance
- **THEN** `intent.emc.edge-distance` reports 1 mm against 3 mm

### Requirement: Ordered chain evaluator

The intent checker SHALL evaluate `layout.relative.chain.<id>` constraints on two measures:
- **order:** each part's projection onto the line from the first part to the last increases in chain order, within half a courtyard;
- **detour:** the summed pad-to-pad path length divided by the first-to-last distance.

It SHALL emit `intent.relative.chain.order` on an order violation, and `intent.relative.chain.length` against a maximum.

#### Scenario: An inductor beyond the connector
- **WHEN** the `amp-output-chain` microboard places its output inductor on the far side of the speaker connector
- **THEN** `intent.relative.chain.order` names the inductor

### Requirement: Subsystem intrusion evaluator

For each subsystem of three or more parts, the intent checker SHALL count the parts of other subsystems whose origin lies inside the convex hull of its members' origins, excluding boundary and mechanical parts. It SHALL report the count as `intrusion_count`, and emit `intent.functional.group.intrusion` (soft) when the count is non-zero.

#### Scenario: A foreign part inside a block
- **WHEN** a resistor of subsystem B is placed at the centre of subsystem A's four parts
- **THEN** `intent.functional.group.intrusion` names the resistor and subsystem A

### Requirement: Placement intent language keys

`docs/LAYOUT.intent.yaml` SHALL accept:
- `electrical.voltages`;
- under `placement`: `critical`, `hot_loops`, `chains`, `isolation`, `channels`, `rf`, `edge_distance`, `thermal`, `exposed_pads` and `matched`.

Each key SHALL compile to its registry constraint with `source: user`. Unknown keys SHALL still hold the run.

#### Scenario: New keys compile
- **WHEN** an intent file declares `placement.hot_loops` with parts `[C3, U2, D1]` and `max_area_mm2: 20`, and `placement.chains` with order `[U3, L1, C12, J3]`
- **THEN** the registry holds `layout.emc.hot-loop.*` and `layout.relative.chain.*` entries with `source: user`

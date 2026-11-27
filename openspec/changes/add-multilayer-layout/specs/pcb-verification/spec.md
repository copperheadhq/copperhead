## MODIFIED Requirements

### Requirement: Checker stack with rule-domain authority
Every candidate SHALL be checked by the copperhead geometry checker, KiCad DRC, the connectivity checker, and the intent checker, plus the kicad-tools DRC and kicad-happy adapters when installed. Authority SHALL be rule-specific: KiCad owns configured board geometry rules, copperhead owns semantic connectivity and intent, the fabrication profile owns manufacturing limits, the physics compiler owns only calculations with complete inputs; heuristics are advisory. Conflicting hard authorities SHALL produce `HOLD` and every disagreement SHALL be recorded as a `checker_disagreement` event. The connectivity checker SHALL join copper across every layer a via spans (`pcb-multilayer`), and the fabrication profile SHALL be the configured one when it matches the board's copper count, else the profile for that count, else a pre-flight refusal.

#### Scenario: Seeded violations are detected with stable codes (AC-17.6)
- **WHEN** the ten golden microboards with seeded shorts, opens, overlaps, out-of-bounds parts, keepout and clearance violations are verified
- **THEN** every seeded violation is reported with its stable diagnostic code and no unseeded error is reported

#### Scenario: Authority conflict holds
- **WHEN** KiCad DRC passes a clearance the fabrication profile marks as below its minimum
- **THEN** the candidate status is `HOLD`, the profile violation is reported, and a `checker_disagreement` event is recorded

#### Scenario: Four-layer completion is measured through vias
- **WHEN** Freerouting routes a four-layer board with every connection made and inner-layer copper joined by through vias
- **THEN** the connectivity checker reports `completion_rate` 1 and no `conn.unrouted`

### Requirement: Hard gates
A placement candidate SHALL fail if any mandatory component is unplaced, courtyards or bodies overlap beyond permitted exceptions, a part is outside the board or inside a keepout, a fixed position or orientation moved, an edge or orientation constraint is violated, or creepage and safety separation are violated. A routing candidate SHALL fail on any short, illegal clearance, route outside the board, illegal via or layer transition, keepout violation, incomplete mandatory connection, violated critical width, or any critical KiCad DRC error under the selected profile. A candidate failing a hard gate SHALL NOT be selectable over one that passes. On this change an illegal via is one whose ends are not the board's two outer copper layers, or not both in the stack.

#### Scenario: Invalid never beats valid (AC-17.7)
- **WHEN** candidate A has a short and shorter total wirelength than candidate B, which passes every gate
- **THEN** B is ranked above A and A is marked ineligible with the gate named

#### Scenario: Buried via fails the routing gate
- **WHEN** a candidate carries a via from `In1.Cu` to `In2.Cu` on a four-layer board
- **THEN** the routing gate fails with `geom.via-layers` and the candidate is ineligible

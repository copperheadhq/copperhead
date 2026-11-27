# pcb-verification — Delta Spec

## ADDED Requirements

### Requirement: Checker stack with rule-domain authority
Every candidate SHALL be checked by the copperhead geometry checker, KiCad DRC, the connectivity checker, and the intent checker, plus the kicad-tools DRC and kicad-happy adapters when installed. Authority SHALL be rule-specific: KiCad owns configured board geometry rules, copperhead owns semantic connectivity and intent, the fabrication profile owns manufacturing limits, the physics compiler owns only calculations with complete inputs; heuristics are advisory. Conflicting hard authorities SHALL produce `HOLD` and every disagreement SHALL be recorded as a `checker_disagreement` event.

#### Scenario: Seeded violations are detected with stable codes (AC-17.6)
- **WHEN** the ten golden microboards with seeded shorts, opens, overlaps, out-of-bounds parts, keepout and clearance violations are verified
- **THEN** every seeded violation is reported with its stable diagnostic code and no unseeded error is reported

#### Scenario: Authority conflict holds
- **WHEN** KiCad DRC passes a clearance the fabrication profile marks as below its minimum
- **THEN** the candidate status is `HOLD`, the profile violation is reported, and a `checker_disagreement` event is recorded

### Requirement: Normalized diagnostics
Every checker SHALL emit diagnostics in the RFC §10.3 shape (code, category, severity, entity ids and references, region, measured and allowed quantities, message, suggested repair actions, source checker). The repair planner SHALL receive only normalized diagnostics.

#### Scenario: KiCad DRC is normalized
- **WHEN** KiCad reports a clearance violation between two tracks
- **THEN** the diagnostic carries category `drc`, both entity ids and refdes-or-net references, measured and allowed clearance, and `sourceChecker` naming the KiCad version

### Requirement: Hard gates
A placement candidate SHALL fail if any mandatory component is unplaced, courtyards or bodies overlap beyond permitted exceptions, a part is outside the board or inside a keepout, a fixed position or orientation moved, an edge or orientation constraint is violated, or creepage and safety separation are violated. A routing candidate SHALL fail on any short, illegal clearance, route outside the board, illegal via or layer transition, keepout violation, incomplete mandatory connection, violated critical width, or any critical KiCad DRC error under the selected profile. A candidate failing a hard gate SHALL NOT be selectable over one that passes.

#### Scenario: Invalid never beats valid (AC-17.7)
- **WHEN** candidate A has a short and shorter total wirelength than candidate B, which passes every gate
- **THEN** B is ranked above A and A is marked ineligible with the gate named

### Requirement: Domain checklist dispositions and envelope
The checks of RFC §10.6 SHALL be implemented with their stated v1 dispositions (gate, metric, advisory, class, v1.1), and the supported envelope of §10.7 SHALL be enforced: a job outside it terminates with `HOLD` or `REFUSE` and the reason. Pre-flight input checks SHALL run once per snapshot and any failure SHALL be `REFUSE` naming the offending refdes or net.

#### Scenario: Pre-flight refuses a courtyard-less footprint
- **WHEN** a snapshot contains a footprint with no courtyard
- **THEN** the run returns `REFUSE` naming the refdes before any engine starts

#### Scenario: Outside the envelope holds
- **WHEN** a board declares four copper layers
- **THEN** the run returns `HOLD` citing the two-layer envelope

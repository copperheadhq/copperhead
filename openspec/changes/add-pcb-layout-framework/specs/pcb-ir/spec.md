# pcb-ir — Delta Spec

## ADDED Requirements

### Requirement: Canonical PCB IR
The framework SHALL represent a board as a versioned, serializable, hashable IR (RFC §6) carrying the board definition (outline, cutouts, layers, thickness, keepouts, fabrication profile), components with stable ids independent of refdes, pads with explicit net connectivity, nets, constraint references into `.copperhead/constraints.json`, placement state with locked ids, and routing state (segments, arcs, vias, preserved zones). Coordinates SHALL be integer nanometres. Every object SHALL map back to its KiCad UUID. Serialization SHALL be canonical so equal designs hash equal.

#### Scenario: Round trip preserves geometry and connectivity (AC-17.1)
- **WHEN** a supported KiCad project is imported to the IR and exported back with no candidate applied
- **THEN** every footprint position, rotation, pad net, track, via, and zone definition is identical, and unsupported constructs the adapter recognises are preserved verbatim

#### Scenario: Canonical hash
- **WHEN** the same project is imported twice, or imported after a refdes-only rename
- **THEN** the IR content hash is identical in the first case and differs only in the reference map in the second

### Requirement: Immutable snapshot contract
Every engine run SHALL receive a `BoardSnapshot` containing the IR schema version and content hash, geometry and fabrication profile, scope, hard constraints, objectives, seed, resource limits, preserved geometry, and the `referenceMap`. An engine SHALL NOT be able to write into the source project; its output is a complete candidate state against the snapshot hash, and a candidate that references a different hash SHALL be rejected as `INVALID_OUTPUT`.

#### Scenario: Engine output cannot modify the source (AC-17.2)
- **WHEN** an engine wrapper writes to the path it was given
- **THEN** the source project's bytes are unchanged and the candidate is read from the isolated run directory

#### Scenario: Stale candidate is rejected
- **WHEN** an engine returns a candidate whose snapshot hash does not match the job
- **THEN** the result status is `INVALID_OUTPUT` naming both hashes

### Requirement: Copper zones are preserved and refilled
The adapter SHALL preserve zone outlines, nets, layers, priorities, clearances, and thermal settings from the input, SHALL NOT author new zones in v1, and SHALL refill zones after applying a candidate and before any check or score. An engine whose manifest does not declare zone understanding SHALL be given an explicitly recorded approximation.

#### Scenario: Zones survive a routed candidate
- **WHEN** a routed candidate is exported for a board with a ground pour
- **THEN** the pour's definition is byte-identical to the input's and its fill is regenerated before DRC runs

### Requirement: KiCad version is pinned
The adapter SHALL target one KiCad major version, SHALL import older boards that parse under the same schema family, and SHALL report a newer major as `UNSUPPORTED` with the pinned version named.

#### Scenario: Newer format refused
- **WHEN** a board declares a file version newer than the pinned major supports
- **THEN** import returns `UNSUPPORTED` naming the pinned and encountered versions

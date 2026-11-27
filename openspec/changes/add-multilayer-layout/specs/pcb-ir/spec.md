## MODIFIED Requirements

### Requirement: Canonical PCB IR
The framework SHALL represent a board as a versioned, serializable, hashable IR (RFC §6) carrying the board definition (outline, cutouts, layers, thickness, keepouts, fabrication profile), components with stable ids independent of refdes, pads with explicit net connectivity, nets, constraint references into `.copperhead/constraints.json`, placement state with locked ids, and routing state (segments, arcs, vias, preserved zones). Coordinates SHALL be integer nanometres. Every object SHALL map back to its KiCad UUID. Serialization SHALL be canonical so equal designs hash equal. The copper layers SHALL be exposed as a stack ordered front to back from the canonical layer names (`pcb-multilayer`), the same for KiCad's legacy and current layer numberings; a via's `layers` SHALL name its two end layers and its span SHALL be the stack slice between them.

#### Scenario: Round trip preserves geometry and connectivity (AC-17.1)
- **WHEN** a supported KiCad project is imported to the IR and exported back with no candidate applied
- **THEN** every footprint position, rotation, pad net, track, via, and zone definition is identical, and unsupported constructs the adapter recognises are preserved verbatim

#### Scenario: Canonical hash
- **WHEN** the same project is imported twice, or imported after a refdes-only rename
- **THEN** the IR content hash is identical in the first case and differs only in the reference map in the second

#### Scenario: Stack is the same under both numberings
- **WHEN** a four-layer board is saved with the legacy numbering and again with the KiCad 10 numbering
- **THEN** both import to the stack `F.Cu, In1.Cu, In2.Cu, B.Cu`, every inner-layer segment keeps its layer, and the two-layer golden boards' hashes are unchanged from before this change

## Purpose
Define mechanical outline, mounting holes, and manufacturing constraints.

## Requirements
### Requirement: Board dimensions and mounting
The PCB SHALL fit within 30 mm x 20 mm with 2x M3 mounting holes on a 24 mm pitch.

#### Scenario: Mechanical fit
- **WHEN** manufactured to design files
- **THEN** the board fits within 30 mm x 20 mm with 24 mm pitch M3 holes.

### Requirement: Manufacturing process
The PCB SHALL use a standard 2-layer, 1 oz copper process with hand-solderable components (0603 or larger).

#### Scenario: PCB fabrication
- **WHEN** fabricated using standard JLCPCB rules
- **THEN** no controlled-impedance or non-standard process steps are required.

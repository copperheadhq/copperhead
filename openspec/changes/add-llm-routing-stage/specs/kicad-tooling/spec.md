# kicad-tooling — Delta Spec

## ADDED Requirements

### Requirement: Track and via tools

The agent SHALL have `add_track` (net name, layer, a polyline of two or more points in mm, width in mm) and `add_via` (net name, position, drill and size in mm, defaulting to 0.3 mm and 0.6 mm), gated on a validated proposal exactly as `edit_file` is. Each SHALL look the net code up in the board's own net table, emit one `(segment …)` per polyline edge or one `(via …)` with a fresh uuid, insert the text before the board's closing parenthesis by anchored splice, probe-load the result with `kicad-cli` in a temporary copy before writing, and mark the board touched so `finish` requires `run_drc`. An unknown net, an unknown copper layer, a non-positive width, or a via drill under the board's rule SHALL be refused with the valid choices named, and the board left byte-identical. The parser SHALL NOT serialize the board.

#### Scenario: A track lands on its net

- **WHEN** `add_track` is called with net `VBUS`, layer `F.Cu`, three points and width 0.8
- **THEN** the board holds two segments on `VBUS`'s net code, KiCad loads it, and DRC sees the connection routed

#### Scenario: Unknown net is refused

- **WHEN** `add_track` names a net the board's net table does not hold
- **THEN** the call fails naming the nets that exist, and the board is unchanged

#### Scenario: Via drill below the rule is refused

- **WHEN** `add_via` asks for a 0.2 mm drill on the scaffold project
- **THEN** the call fails naming the 0.3 mm rule, and the board is unchanged

### Requirement: Board reading tools

The agent SHALL have `board_pads` (optional refdes list), listing each pad's refdes, number, net, layers, size and absolute position derived from the footprint's placement and rotation, and `list_unrouted`, listing each unrouted connection's net and both pad endpoints with positions from the DRC report. Both SHALL be read-only and LLM-free.

#### Scenario: Pad positions follow the footprint

- **WHEN** a footprint is placed at (100, 50) rotated 90° and `board_pads` lists it
- **THEN** each pad's position equals the footprint origin plus its offset rotated by 90°, matching KiCad's DRC item coordinates

#### Scenario: Unrouted connections with endpoints

- **WHEN** DRC reports two `unconnected_items`
- **THEN** `list_unrouted` returns two entries, each with the net name and both pad endpoints

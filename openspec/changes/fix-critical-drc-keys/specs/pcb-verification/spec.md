## ADDED Requirements

### Requirement: Critical DRC by fixed key list across severities

The KiCad DRC checker SHALL count critical violations over both the violation (error) and warning buckets, using the profile's `criticalDrc` list.

The fabrication profiles' critical lists SHALL name KiCad 10's keys. In particular, `hole_to_hole` replaces `hole_near_hole`.

The checker SHALL additionally report `drc_placement_critical_count`, over the placement-stage list:
- `courtyards_overlap`;
- `pth_inside_courtyard`;
- `npth_inside_courtyard`;
- `items_not_allowed`;
- `copper_edge_clearance`;
- `hole_to_hole`;
- `invalid_outline`.

The routability probe SHALL report `routability_drc_critical` beside `routability_drc_errors`.

#### Scenario: A critical warning counts
- **WHEN** KiCad reports `pth_inside_courtyard` at warning severity on a board whose profile lists it as critical
- **THEN** `drc_critical_count` includes it

#### Scenario: The hole key matches KiCad 10
- **WHEN** KiCad 10 reports `hole_to_hole`
- **THEN** the violation is counted as critical under `jlcpcb-2layer`

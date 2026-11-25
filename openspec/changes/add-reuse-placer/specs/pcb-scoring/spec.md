## ADDED Requirements

### Requirement: Tiered placement ranking

A scoring profile MAY carry `tiers`: an ordered list of tiers, each holding metrics with a direction and a tolerance (absolute or relative).

When a profile carries tiers, `rank()` SHALL:
1. order ineligible candidates below eligible ones;
2. compare eligible candidates tier by tier, where values within tolerance count as equal and an unmeasured metric compares as unknown;
3. break final ties with the weighted score;
4. keep Pareto membership.

Profiles without tiers SHALL rank exactly as before.

The `engineering-placement-2-layer` profile SHALL define tiers T1 to T9: mechanical, datasheet placement, antenna and thermal, loop area, separation, orientation, routability, trace length, neatness.

#### Scenario: Loop area outranks wirelength
- **WHEN** two eligible candidates are equal within tolerance on T1 to T3, candidate A's loop area is 30 % smaller, and candidate B's HPWL is 20 % shorter
- **THEN** candidate A ranks first

#### Scenario: Existing profiles are unchanged
- **WHEN** `default-placement-2-layer` ranks the B2 microboard candidates
- **THEN** the ranking equals the ranking before this change

### Requirement: Routability probe on a net subset

`routabilityProbe` SHALL accept `netNames`, and route only those nets when it is given.

#### Scenario: Only critical nets are routed
- **WHEN** the probe runs with `netNames` naming two nets of a ten-net board
- **THEN** the router's job carries only those two nets, and completion is measured over their connections

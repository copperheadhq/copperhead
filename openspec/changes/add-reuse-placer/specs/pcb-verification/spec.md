## ADDED Requirements

### Requirement: Placement utilisation pre-flight

The pre-flight checker SHALL compute a utilisation per board side:
- **usable area:** outline minus cutouts, minus keepouts, minus the edge band;
- **demand:** summed courtyard extents, or pad boxes where there is no courtyard;
- **utilisation:** demand divided by usable area.

It SHALL:
- emit `preflight.utilisation.over-capacity` (error, gating) when a side exceeds `placementUtilisationMax` (default 0.95), or when a part fits the inset outline at no rotation, stating the shortfall, the growth that reaches the warning threshold, and the largest parts;
- emit `preflight.utilisation.dense` (warning) above `placementUtilisationWarn` (default 0.62);
- emit `preflight.utilisation.pad-extents` (info) when under 90 % of parts carry courtyards.

#### Scenario: An over-capacity board is refused
- **WHEN** a board's front side demand is 1.1 times its usable area
- **THEN** pre-flight fails with `preflight.utilisation.over-capacity` naming the side and the shortfall, and no engine runs

#### Scenario: A dense board runs with a warning
- **WHEN** a board's fuller side is at 0.7 utilisation
- **THEN** `preflight.utilisation.dense` is a warning, and placement proceeds

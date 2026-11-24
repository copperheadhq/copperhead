# cli-surface delta spec

## ADDED Requirements

### Requirement: `check` reports stale and missing pour fills

`check` SHALL stay read-only for zone fills: it SHALL never write the board. When its DRC fails and zone refill is available, it SHALL refresh a scratch copy and, when the copy's DRC has fewer violations, report that the pour fills are stale and how many findings they account for. It SHALL report every copper zone that has no fill data, which needs no kicad-cli run. These findings SHALL NOT change `check`'s exit code, which DRC and the other checks already decide, and `check --json` SHALL carry them in a `fills` object on its `drc` result. A board with no copper zones SHALL cost no extra kicad-cli run.

#### Scenario: A stale fill is named, the board untouched (AC-22.16)

- **WHEN** `check` runs on a board where a pad was moved into a GND pour without a refill
- **THEN** it exits non-zero on the DRC failure, prints that the pour fills are stale and account for its clearance findings, and the board file's hash is unchanged

#### Scenario: An unfilled pour is reported (AC-22.17)

- **WHEN** `check` runs on a board whose GND zone has an outline and no fill
- **THEN** it names the zone as unfilled, its exit code is the one DRC and the other checks give, and `check --json` lists the zone under `drc.fills.unfilled`

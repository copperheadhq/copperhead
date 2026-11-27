# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `check` runs the SPICE gate
`copperhead check --spice` SHALL run the SPICE gate for every subsystem flagged by a `## Simulation` block when ngspice is installed, report loud skips per the spice-verification capability when it is not, and include a stable `spice` key in `--json` output (per-assertion `{assertion, status, measured?, bound?}` entries plus the skip state). Default `check` (no `--spice`) SHALL NOT run the gate and SHALL NOT emit a `spice` key, so AC-2.4 JSON keys stay unchanged. `--strict` SHALL fail a skip and SHALL NOT fail an idle gate. The gate SHALL keep `check` LLM-free and network-free.

#### Scenario: check verifies assertions
- **WHEN** `check --spice` runs on the fixture with a passing `## Simulation` block and ngspice installed
- **THEN** the output shows the SPICE gate ✓ with the assertion count, and the exit code is 0

#### Scenario: check --json exposes spice results
- **WHEN** `check --spice --json` runs on a flagged repo
- **THEN** the JSON contains a `spice` key with one entry per assertion, including measured values for evaluated assertions

#### Scenario: default check JSON is unchanged
- **WHEN** `check --json` runs without `--spice`
- **THEN** the JSON keys are exactly `constraints`, `drc`, `drift`, `erc`, `legibility`, `ok`, `openspec`

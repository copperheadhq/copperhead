# spice-verification — Delta Spec

## Issue #308 implemented subset

The first implementation is explicitly requested with `check --spice`. It
selects three-terminal `Regulator_Linear` symbols from the read-only schematic
reader and finds output targets using the existing constraint registry's
numeric `value`, `min`, `max`, and `affects` fields. An `op` Simulation block
declares the input voltage. A local three-pin subcircuit must be attached
through KiCad's `Sim.Library`, `Sim.Name`, and `Sim.Pins` symbol fields. The
subprocess receives a bounded, regulator-specific DC deck and the check
reports measured output against inclusive bounds. No target means `not_checked`;
missing inputs, missing/unusable models, non-convergence, timeout, and a missing
ngspice executable fail the explicit check. The remaining requirements below
describe the unimplemented full gate and are not claimed by this slice.

## ADDED Requirements

### Requirement: Simulation opt-in via SUBSYSTEMS.md
A subsystem SHALL be flagged for SPICE verification by a `## Simulation` block in SUBSYSTEMS.md. The line-oriented block SHALL contain one `scope: sheet <path>` or `scope: nets <net>, <net>` field, one `analysis: op|dc|ac|tran` field, optional repeated `source: <port>=<number>` lines for driven ports, and one or more `assert: <assertion>` lines. The `sources` field name SHALL be accepted as an alias for `source`. Fenced code examples and non-field narrative lines SHALL NOT be parsed as live Simulation input. A scope that references sheets or nets absent from the schematic SHALL be reported as a failure by `check`.

#### Scenario: Flagged subsystem is picked up
- **WHEN** SUBSYSTEMS.md contains a `## Simulation` block scoped to the divider sheet with an `op` analysis
- **THEN** the SPICE gate includes that subcircuit and its assertions in the next verify run

#### Scenario: Dangling scope fails
- **WHEN** a `## Simulation` block references net `VOUT_X` that no longer exists in the schematic
- **THEN** `check` exits non-zero naming the block and the missing net

### Requirement: Assertion grammar
Assertions SHALL use the closed grammar: measurables `V(<net>)`, `I(<refdes>)`, and `corner(<net>)`; comparators `between <a> and <b>`, `< <x>`, `> <x>`; numbers with SI suffixes. Both `between` bounds SHALL omit units or use the same unit, compared case-insensitively. The gate SHALL compile assertions to ngspice `.meas` directives and SHALL reject any other syntax with a parse error naming the line. Raw ngspice control blocks SHALL NOT be accepted.

#### Scenario: Valid assertion compiles
- **WHEN** a block contains `V(VREF) between 3.25 and 3.35`
- **THEN** the generated ngspice deck contains a corresponding `.meas` directive and the result is evaluated against both bounds

#### Scenario: Arbitrary control block rejected
- **WHEN** a block contains a raw `.control` line
- **THEN** the gate fails with a parse error naming the offending line, without invoking ngspice

### Requirement: Scoped netlist export and ngspice execution
The gate SHALL export the scoped SPICE netlist via `kicad-cli sch export netlist --format spice`, run ngspice in batch mode as a local subprocess with a configurable timeout, and SHALL make zero network calls. ngspice absence SHALL be detected up front and reported with an install hint.

#### Scenario: Batch run on fixture subcircuit
- **WHEN** the verify step runs on the fixture divider with ngspice installed
- **THEN** the transcript records the netlist export, the ngspice invocation, and each assertion's measured value

### Requirement: Results normalize into the standard violation shape
Assertion failures SHALL be reported as `{severity, type: "spice_assertion", description, sheet, measured, bound}` through the same reporting path as ERC/DRC violations. A simulation that fails to run (missing model, convergence failure, timeout) SHALL be reported as a distinct failure with the ngspice stderr excerpt, never as a pass.

#### Scenario: Failed assertion carries measured value
- **WHEN** `V(VREF)` measures 3.1 V against bound 3.25–3.35 V
- **THEN** the violation reports measured 3.1 V and the bound, attributed to the subsystem's sheet

#### Scenario: Unrunnable simulation is a failure
- **WHEN** the scoped netlist references a symbol with no simulation model
- **THEN** the gate reports a simulation-failed violation with the ngspice error excerpt and the run does not count the assertions as verified

### Requirement: Skip semantics without ngspice
When `## Simulation` blocks exist and ngspice is not installed, `check` SHALL print "SPICE gate skipped (ngspice not found)" with the count of unverified assertions and exit 0; with `--strict`, the same condition SHALL exit non-zero. The skip SHALL never be silent.

#### Scenario: Loud skip by default
- **WHEN** `check` runs on a flagged repo without ngspice
- **THEN** the output names the skipped gate and the number of unverified assertions, and the exit code is 0

#### Scenario: Strict CI fails on skip
- **WHEN** `check --strict` runs on the same repo
- **THEN** the exit code is non-zero citing the unverified assertions

### Requirement: Budget-derived assertions are dual-written
An assertion that enforces a SPEC.md budget SHALL reference the budget, and the pairing SHALL be recorded in the constraint registry under the existing dual-write obligation; weakening such an assertion without updating the budget SHALL be reported by the sync-obligations ledger.

#### Scenario: Leakage assertion links its budget
- **WHEN** a block asserts `I(R5) < 25uA` derived from the sleep-current budget
- **THEN** `constraints.json` contains the pairing with its source, and `check` verifies the assertion bound does not exceed the budget

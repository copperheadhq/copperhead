# spice-verification — Delta Spec

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

### Requirement: Analyses measure at the declared operating point
Because ngspice `.meas` accepts only `tran`, `ac`, `dc`, and `sp`, `op` and `dc` blocks SHALL be measured on a DC sweep centred on the first source's declared value and read at that value (`FIND ... AT=`), never averaged over a sweep. An `ac` block SHALL drive its first source with an `AC 1` stimulus and SHALL be a parse error without a source; `corner()` outside an `ac` block SHALL be a parse error.

#### Scenario: Operating point is measured at the declared source value
- **WHEN** a block declares `analysis: op` (or `dc`) with `source: VIN=5`
- **THEN** the deck sweeps the VIN source around 5 and each `.meas dc` reads its value `AT=5`

#### Scenario: AC corner has a stimulus
- **WHEN** a block declares `analysis: ac`, `source: VIN=0`, and `assert: corner(VOUT) between 1.5k and 1.7k`
- **THEN** the deck drives VIN with `AC 1`, saves all vectors, and measures the -3 dB point of `VOUT`

### Requirement: Scoped netlist export and ngspice execution
The gate SHALL export the schematic's SPICE netlist via `kicad-cli sch export netlist --format spice` (KiCad's exporter emits the whole schematic; each block's scope is validated against the schematic and its `source` lines name the driven ports), run ngspice in batch mode as a local subprocess with a configurable timeout, and SHALL make zero network calls. ngspice absence SHALL be detected up front and reported with an install hint.

#### Scenario: Batch run on fixture subcircuit
- **WHEN** `check --spice` runs on the fixture divider with ngspice installed
- **THEN** the `spice` result records the ngspice version and each assertion's measured value

### Requirement: The deck runs only what the gate compiled
Before ngspice runs, the gate SHALL refuse a netlist, or a local file it includes with `.include` / `.lib`, that contains `.control` / `.endc` or `.meas` cards, or that includes a URL. ngspice SHALL run as `ngspice -n -b` in a fresh temporary directory so no `.spiceinit` is loaded. Only the measure names the gate compiled SHALL be read, from ngspice stdout; a name printed more than once SHALL fail the run.

#### Scenario: Schematic control block refused
- **WHEN** the exported netlist contains a `.control` block (for example from a schematic text item)
- **THEN** the gate fails naming the netlist line, and ngspice is never invoked

#### Scenario: Echoed measure is not a measurement
- **WHEN** ngspice output carries a gate measure name twice, or only on stderr
- **THEN** the assertion is not counted as passing

### Requirement: Results normalize into the standard violation shape
Assertion failures SHALL be reported as `{severity, type: "spice_assertion", description, sheet, measured, bound}` in the ERC/DRC violation shape, in the `violations` list of the `check --spice` result (`sheet` only for a sheet-scoped block; the loop repair path lands with task 3.1). A simulation that fails to run (missing model, convergence failure, timeout) SHALL be reported as a distinct `spice_simulation_failed` violation with the ngspice stderr excerpt, never as a pass.

#### Scenario: Failed assertion carries measured value
- **WHEN** `V(VREF)` measures 3.1 V against bound 3.25–3.35 V
- **THEN** the violation reports measured 3.1 V and the bound, attributed to the subsystem's sheet

#### Scenario: Timeout is reported as a timeout
- **WHEN** an ngspice run exceeds `spice.timeoutMs`
- **THEN** the gate reports a `spice_simulation_failed` violation reading "simulation timed out after <n> ms"

#### Scenario: Unrunnable simulation is a failure
- **WHEN** the scoped netlist references a symbol with no simulation model
- **THEN** the gate reports a simulation-failed violation with the ngspice error excerpt and the run does not count the assertions as verified

### Requirement: Skip semantics without ngspice
When `## Simulation` blocks exist, `check --spice` is passed, and ngspice is not installed, `check` SHALL print "SPICE gate skipped (ngspice not found)" with the count of unverified assertions and exit 0; with `--strict`, the same condition SHALL exit non-zero. The skip SHALL never be silent. Default `check` without `--spice` SHALL NOT probe ngspice.

#### Scenario: Loud skip by default
- **WHEN** `check --spice` runs on a flagged repo without ngspice
- **THEN** the output names the skipped gate and the number of unverified assertions, and the exit code is 0

#### Scenario: Strict CI fails on skip
- **WHEN** `check --spice --strict` runs on the same repo
- **THEN** the exit code is non-zero citing the unverified assertions

### Requirement: Budget-derived assertions are dual-written
An assertion that enforces a SPEC.md budget SHALL reference the budget, and the pairing SHALL be recorded in the constraint registry under the existing dual-write obligation; weakening such an assertion without updating the budget SHALL be reported by the sync-obligations ledger.

#### Scenario: Leakage assertion links its budget
- **WHEN** a block asserts `I(R5) < 25uA` derived from the sleep-current budget
- **THEN** `constraints.json` contains the pairing with its source, and `check` verifies the assertion bound does not exceed the budget

### Requirement: ngspice detection is exit-code and banner based
ngspice SHALL count as installed only when a bounded `ngspice -v` exits 0 and prints an `ngspice-<version>` banner, so a Windows shell's "is not recognized" answer is a skip, not an unrunnable simulation. A probe that does not exit within its timeout SHALL fail the gate.

#### Scenario: Windows shell without ngspice
- **WHEN** `check --spice` runs on Windows and the shell answers `ngspice -v` with exit 1 and "'ngspice' is not recognized"
- **THEN** the gate is the same loud skip, and the exit code is 0

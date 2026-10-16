# Tasks: add-spice-verification-gate

## Issue #308 first slice

- [x] Explicit `check --spice` runs one local, bounded ngspice DC operating-point
  check for declared three-terminal linear regulators and reports text/JSON.
- [x] Existing schematic, constraint, and Simulation parsers supply connectivity,
  output bounds, and the declared input source; unusable models cannot pass.
- [x] Unit and environment-gated integration tests cover the first slice.

The broader tasks below remain open; this slice does not complete them.

## 1. Wrapper and grammar

- [ ] 1.1 Implement ngspice wrapper in `src/kicad/spice.ts` mirroring the kicad-cli wrapper: execa batch mode, version detection, install hint, per-run timeout from config
- [x] 1.2 Implement the `## Simulation` block parser (scope, analysis, sources, assertions) with parse errors naming lines; reject raw control blocks
- [x] 1.3 Implement the assertion grammar → `.meas` directive compiler with SI-suffix number parsing; unit tests for every measurable/comparator pair

## 2. Netlist scoping and execution

- [ ] 2.1 Implement scoped netlist export via `kicad-cli sch export netlist --format spice` (sheet scope and net-set scope); failure for unresolvable scopes
- [ ] 2.2 Implement deck assembly (netlist + sources + analysis + measures + tuned `.options`) and batch execution
- [ ] 2.3 Implement result parsing and normalization to `{severity, type: "spice_assertion", description, sheet, measured, bound}`; distinct simulation-failed reporting with stderr excerpt

## 3. Gate wiring

- [ ] 3.1 Wire the gate into the loop verify step (touched flagged subsystems only), feeding violations to the existing repair loop; rollback path covered
- [ ] 3.2 Wire the gate into `check`: run when ngspice present, loud skip with counts when absent, `--strict` escalation; `spice` key in `--json`
- [ ] 3.3 Implement scope drift check: `## Simulation` scopes referencing missing sheets/nets fail `check`
- [ ] 3.4 Implement budget-assertion dual-write: registry pairing with source, ledger obligation on assertion edits, bound-vs-budget mechanical check
- [ ] 3.5 Add `spice` config block (enable, ngspice path, timeouts) to `.copperhead/config.json` and document it in the generated `.copperhead/README.md`

## 4. Fixtures and tests

- [ ] 4.1 Add a fixture analog subcircuit (divider + RC on its own sheet) with a passing `## Simulation` block; capture netlist and ngspice output fixtures
- [ ] 4.2 Add a failing variant (assertion out of bounds) and an unrunnable variant (symbol without a model)
- [ ] 4.3 Tests: pass, fail-with-measured-value, unrunnable-is-failure, loud skip, `--strict` skip failure, scope drift, ledger obligation
- [ ] 4.4 Network guard test over the full gate; runtime within the `check` budget on the fixture

## 5. Docs

- [ ] 5.1 README: SPICE gate section (opt-in block format, assertion grammar, skip semantics, ngspice install)
- [ ] 5.2 On archive, move ngspice from SPEC.md §8 roadmap into the verify architecture section (via /opsx:archive)

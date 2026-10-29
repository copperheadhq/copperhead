# Tasks: add-spice-verification-gate

Check-command slice (this change's first landing): wrapper, grammar, deck assembly, `check --spice` / `--strict`, scope drift, config plumbing, fixtures, docs. Loop verify (3.1), budget dual-write (3.4), and the SPEC.md archive move (5.2) stay open.

## 1. Wrapper and grammar

- [x] 1.1 Implement ngspice wrapper mirroring the kicad-cli wrapper: execa batch mode, version detection, install hint, per-run timeout from config (`src/kicad/spice-run.ts`; the parser in `spice.ts` stays pure)
- [x] 1.2 Implement the `## Simulation` block parser (scope, analysis, sources, assertions) with parse errors naming lines; reject raw control blocks
- [x] 1.3 Implement the assertion grammar → `.meas` directive compiler with SI-suffix number parsing; unit tests for every measurable/comparator pair

## 2. Netlist scoping and execution

- [x] 2.1 Implement SPICE netlist export via `kicad-cli sch export netlist --format spice`; unresolvable sheet/net scopes fail `check` (KiCad's exporter emits the whole schematic; the gate refuses dangling scopes and drives named ports)
- [x] 2.2 Implement deck assembly (netlist + sources + analysis + measures + tuned `.options`) and batch execution
- [x] 2.3 Implement result parsing and per-assertion `{assertion, status, measured?, bound?, detail, line}`; distinct simulation-failed reporting with stderr excerpt

## 3. Gate wiring

- [ ] 3.1 Wire the gate into the loop verify step (touched flagged subsystems only), feeding violations to the existing repair loop; rollback path covered
- [x] 3.2 Wire the gate into `check --spice`: run when ngspice present, loud skip with counts when absent, `--strict` escalation; `spice` key in `--json` only when `--spice` ran (design D7)
- [x] 3.3 Implement scope drift check: `## Simulation` scopes referencing missing sheets/nets fail `check --spice`
- [ ] 3.4 Implement budget-assertion dual-write: registry pairing with source, ledger obligation on assertion edits, bound-vs-budget mechanical check
- [x] 3.5 Add `spice` config block (ngspice path, timeout) to `.copperhead/config.json` and document it in the generated `.copperhead/README.md`. Enable remains the `--spice` flag (D7)

## 4. Fixtures and tests

- [x] 4.1 Add captured divider netlist and ngspice stdout fixtures plus a passing `## Simulation` block
- [x] 4.2 Add a failing variant (assertion out of bounds) and an unrunnable variant (missing model / ngspice stderr)
- [x] 4.3 Tests: pass, fail-with-measured-value, unrunnable-is-failure, loud skip, `--strict` skip failure, scope drift (ledger obligation waits on 3.4)
- [x] 4.4 Network guard: module-graph test over the spice-run import tree (no provider / SDK)

## 5. Docs

- [x] 5.1 README: SPICE gate section (opt-in block format, assertion grammar, skip semantics, ngspice install); CLI / verify / configuration pages
- [ ] 5.2 On archive, move ngspice from SPEC.md §8 roadmap into the verify architecture section (via /opsx:archive)

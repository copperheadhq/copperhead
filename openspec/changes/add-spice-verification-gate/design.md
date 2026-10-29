# add-spice-verification-gate: Design

## Context

Issue #308 lands a deliberately smaller first slice of this design: explicit
`check --spice` for three-terminal `Regulator_Linear` DC operating points only.
It reads the existing constraint registry's numeric `value`/`min`/`max` and
`affects` fields, the existing `## Simulation` parser's `op` input source,
and KiCad's `Sim.Library`/`Sim.Name`/`Sim.Pins` fields. The read-only schematic
reader supplies pin-to-net connectivity; it emits only the regulator, source,
and direct resistive output load. Full sheet/net scoping, other analyses, loop
repair, and model management below remain future work.

The verify step is deliberately checker-agnostic: ERC and DRC are subprocess runs whose JSON output is normalized into one violation shape that the repair loop consumes. SPEC.md §8 lists ngspice as the first planned simulation checker. KiCad ships SPICE netlist export (`kicad-cli sch export netlist --format spice`), and most KiCad symbol libraries carry simulation models for passives and common actives; MCU-class parts do not simulate, which is why the gate must be scoped, not whole-schematic.

## Goals / Non-Goals

**Goals:**

- Behavioral assertions ("V(out) stays in range", "leakage under budget") verified by ngspice with the same repair-or-rollback discipline as ERC/DRC.
- Zero burden on repos that never opt in; explicit, never-silent skipping when ngspice is absent.
- Assertions tied into the constraint registry so simulation and budgets stay dual-written.

**Non-Goals:**

- No whole-schematic simulation: digital parts and connectors have no models; forcing it would make the gate permanently red.
- No model management or vendor model downloads (network-free); models come from the KiCad libraries in the repo.
- No EMC/openEMS in this change (SPEC.md §8 keeps it as a later checker on the same interface).
- No waveform UI; results are pass/fail assertions with measured values in text.

## Decisions

- **D1: Opt-in scope lives in SUBSYSTEMS.md, not config.** A `## Simulation` block under the subsystem it verifies keeps the assertion next to the design intent it protects, visible in review, and drift-checkable (the block names nets that must exist in the schematic). Alternative: `spice` config array — rejected; config is machine-plumbing, and behavioral requirements are design documentation.
- **D2: Scope by sheet or explicit net set.** The exporter takes either a hierarchical sheet reference (simulates that sheet's subcircuit with its ports driven per the block's `sources` lines) or an explicit net list. Sheet scoping matches how analog subcircuits are actually drawn; net-set scoping covers cross-sheet cases. Unresolvable scopes are a check failure, not a skip.
- **D3: Assertion grammar is small and closed.** `V(<net>)`, `I(<ref>)`, and `corner(<net>)` measurables; `between a and b`, `< x`, `> x` comparators; SI-suffixed numbers. Parsed by us, compiled to ngspice `.meas` directives. Alternative: raw ngspice control blocks — rejected as unreviewable and injection-prone; power users can still commit plain `.sp` files outside the gate.
- **D4: Skip is loud, and `--strict` makes it fatal.** A repo with `## Simulation` blocks on a machine without ngspice prints "SPICE gate skipped (ngspice not found): N assertions unverified" and exits 0; CI runs `--strict` and fails. A silent pass would forge the "verified" claim, and a hard default failure would break every contributor without ngspice installed.
- **D5: Results normalize into the existing violation shape.** `{severity, type: "spice_assertion", description, sheet, measured, bound}` feeds the same repair loop ERC uses; the model sees "assertion failed, measured 3.1 V, bound 3.25-3.35 V" and can act. No parallel reporting path.
- **D6: ngspice wrapper mirrors the kicad-cli wrapper.** execa, batch mode (`ngspice -b`), version detection with a clear install hint, per-run timeout from config. Same subprocess trust model, same testing pattern (captured outputs as fixtures).

## Risks / Trade-offs

- [Missing simulation models make a scoped netlist unrunnable] → the gate distinguishes "assertion failed" from "simulation failed to run" (model missing, convergence failure); the latter is reported with the ngspice stderr excerpt and treated as a failure of the gate, since an unrunnable assertion is unverified.
- [ngspice convergence flakiness on marginal circuits] → `.options` defaults tuned for small circuits committed in the wrapper; per-analysis timeout; convergence failure message includes the standard remedies. Fixture tests pin behavior on a known-good circuit.
- [Netlist export differences across KiCad versions] → version detection already warns on untested majors; captured netlist fixtures pin the parser.
- [Agent gaming the gate by editing assertions] → `## Simulation` edits are ordinary doc edits: they require the spec gate like everything else, land in the diff for review, and budget-derived assertions carry a registry link the sync-obligations ledger checks (weakening an assertion below its budget is a constraint dual-write violation).

## Migration Plan

Additive: no `## Simulation` blocks, no change. The fixture gains a simulatable subcircuit; SPEC.md §8's ngspice line moves from roadmap to the verify section on archive.

## Open Questions

- Whether `create` should emit `## Simulation` blocks for analog subsystems it designs (probably yes, later change: it strengthens the pipeline's own gates but needs prompt work).
- Minimum supported ngspice version (decide during implementation against distro packages; wrapper detects and reports regardless).

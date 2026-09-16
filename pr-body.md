# Finish linear-regulator DC operating-point checks in `check` (#308)

`copperhead check --spice` now checks declared three-terminal linear regulators with a local, bounded ngspice `.op` run. It reuses the schematic connectivity reader, the existing Simulation block parser, and the constraint registry's voltage target and bounds. Each regulator reports its measured output and inclusive tolerance in text and `--json`; missing ngspice, missing or unusable models, non-convergence, and absent measurements fail explicitly. A regulator without a declared voltage constraint is `not_checked`. The check remains read-only and network-free.

This is the first vertical slice only. Transient analysis, other circuit types, arbitrary topologies, and generalized deck generation remain deferred. The OpenSpec change and CLI documentation mark that boundary.

Validation on Windows:
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Focused SPICE and adjacent `check` suites: 23 passed, 1 skipped (ngspice executable is unavailable here).
- `npm run docs:build` with Astro telemetry disabled: passed (17 pages).
- `openspec validate add-spice-verification-gate`: passed.
- Full `npm test`: 981 passed, 27 failed, 22 skipped across 74 files. The failures include Windows newline/path assertions and parallel-load timeouts; the new CLI test timed out in that run and passed when rerun in isolation. See `issue-308-npm-test.log` and `issue-308-focused-test.log` beside the worktree. No successful ngspice simulation is claimed because this machine has no ngspice binary.

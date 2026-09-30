# Finish linear-regulator DC operating-point checks in `check` (closes #308)

## Summary

`copperhead check --spice` checks declared three-terminal linear regulators with a local, bounded ngspice `.op` run. It reuses the existing schematic connectivity reader, Simulation block parser, and constraint registry, then reports the measured output against the declared target and inclusive tolerance in text and `--json`.

## What's included

- Explicit failure results for a missing ngspice binary, missing or unusable component models, non-convergence, and absent measurements.
- `not_checked` for a regulator without a declared voltage constraint, never a false pass.
- Unit coverage for netlist translation, inclusive tolerance boundaries, output rendering, and all explicit failure modes.
- An integration test that runs the local ngspice binary when available.

## What's explicitly deferred

This is the first vertical slice only. Transient analysis, other circuit types, arbitrary topologies, and generalized deck generation remain deferred. The boundary is recorded in `openspec/changes/add-spice-verification-gate/` and the CLI documentation.

## Invariants

The check is read-only and network-free. ngspice is invoked only as a bounded local subprocess; no provider, API key, network access, write tool, project file, or Git index is touched. This does not affect spec-gated-in and adds an additional read-only check to verification-gated-out without weakening existing mutation, ERC/DRC, rollback, or obligations protections.

## Real validation results

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run docs:build` with Astro telemetry disabled: passed (17 pages).
- `openspec validate add-spice-verification-gate`: passed.
- Focused SPICE and adjacent `check` suites: 23 passed, 1 skipped in the earlier combined run.
- Final focused SPICE suite with the real binary: 7 passed, 1 guarded skip. The skipped test is the missing-binary case, which is guarded when ngspice is available.

Real integration command and output:

```text
$ npm test -- test/regulator-op.test.ts --maxWorkers=1 --minWorkers=1 --reporter=verbose
✓ ngspice integration > runs the local ngspice binary on the modeled regulator fixture
Test Files  1 passed (1)
Tests  7 passed | 1 skipped (8)
```

Manual commands against generated fixture variants:

```text
$ node --import tsx src/cli.ts --repo <known-good-fixture> check --spice
SPICE U1 (1V5): PASS — 1.5 V; target 1.5 V, tolerance 1.4–1.6 V

$ node --import tsx src/cli.ts --repo <wrong-output-fixture> check --spice
SPICE U1 (1V5): FAIL — 1.8 V; target 1.5 V, tolerance 1.4–1.6 V
```

Both fixture checks also reported 16 unrelated ERC violations, so their overall `check` exit code was 1; the SPICE subcheck results above were distinct and correct.

The clean parent (`f2944e4`) full suite recorded 980 passed, 22 failed, and 21 skipped. The feature branch full suite recorded 981 passed, 27 failed, and 22 skipped. The baseline failures are Windows newline/path assertions, existing safety behavior differences, and parallel-load timeouts across draft, gating, MCP, REPL, check, and registry tests. The five requested full-suite reruns showed the same load-sensitive existing failures varying between 21 and 25 failed tests; the new `regulator-op` CLI test passed in all five runs. No new deterministic failure from this feature was identified.

## Files changed

- CLI and check command: `src/cli.ts`, `src/commands/check.ts`.
- Regulator simulation: `src/kicad/regulator-op.ts`, with the existing S-expression parser updated as needed.
- Tests: `test/regulator-op.test.ts`.
- Documentation: `README.md`, `docs/src/content/docs/reference/cli.md`.
- OpenSpec: `openspec/specs/SPEC.md` and `openspec/changes/add-spice-verification-gate/`.

## Known limitations

ngspice 47 was verified on Windows. Cross-platform simulator behavior and vendor-specific regulator models were not exhaustively tested. The manual fixtures use a behavioral surrogate model and intentionally retain unrelated ERC issues so the SPICE pass/fail result is isolated.

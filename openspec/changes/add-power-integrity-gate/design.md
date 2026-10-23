# add-power-integrity-gate: Design

## Decisions

1. **External subprocess adapter & licensing**: Invokes `COPPERHEAD_KIPIDA_BIN` (default `ki-pida --json <board.kicad_pcb>`) as a separate OS process with `stdin: 'ignore'` and a 30s default timeout (`COPPERHEAD_KIPIDA_TIMEOUT_MS`). Like `ngspice` in `add-spice-verification-gate`, external power-integrity solvers (e.g. KiPI / padne / IPC Python wrappers emitting the documented JSON telemetry contract) are optional system dependencies and are never bundled or vendored.
2. **Fail-closed boundary validation**: `validatePidaTelemetry` rejects non-objects, unknown snake_case keys, non-array sections, missing/non-finite numeric fields, and empty `{}` payloads so malformed adapter output can never silently report `power-integrity ✓`.
3. **Skip-with-reason vs `--strict-power`**: Following the SPICE gate precedent, `check --power` reports `power-integrity skipped (...)` when the external binary is not installed, while `check --power --strict-power` fails the run. When telemetry arrives for a category with no `power.*` budget in `constraints.json`, the checker emits an explicit `power_budget_missing` warning rather than a silent pass.

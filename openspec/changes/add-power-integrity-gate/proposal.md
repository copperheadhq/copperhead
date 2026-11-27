# add-power-integrity-gate: Proposal

## Why

DRC passes boards whose traces drop excessive voltage under load or exceed copper current-density and thermal budgets. Copperhead needs an opt-in, deterministic, fail-closed DC power-integrity verification gate (`copperhead check --power`) backed by an external subprocess adapter without bundling GPL tools or touching any LLM/network.

## What Changes

- **Pluggable `VerificationChecker` registry (`src/kicad/checkers.ts`) and DC power-integrity checker (`src/kicad/pida.ts`)**: validates JSON telemetry strictly at the boundary (rejecting empty `{}` or schema-mismatched output), enforces a configurable subprocess timeout (`COPPERHEAD_KIPIDA_TIMEOUT_MS`, default 30s) with `stdin: 'ignore'`, parses hierarchical `/`-prefixed rail budgets, warns when telemetry categories have no configured budget, and formats near-threshold values with sufficient precision.
- **Opt-in `copperhead check --power [--strict-power]`**: skips with an explicit install hint (`skipped: true`) when `ki-pida` (`COPPERHEAD_KIPIDA_BIN`) is absent unless `--strict-power` is set, and exposes `power` in `CheckResult` (`--json`). Agent loop (`run_power_integrity` tool and IPC bridge) remains future work under #176.

## Capabilities

### New Capabilities

- `power-integrity`: fail-closed DC power-integrity telemetry validation and budget checking against `.copperhead/constraints.json`.

### Modified Capabilities

- `cli-surface`: adds opt-in `--power` and `--strict-power` flags to `copperhead check`.

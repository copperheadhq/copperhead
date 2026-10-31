# add-power-integrity-gate: Tasks

- [x] 1.1 Implement `VerificationChecker` registry (`src/kicad/checkers.ts`) and fail-closed `powerIntegrityChecker` (`src/kicad/pida.ts`) with timeout, install hint, hierarchical rail keys, and precision formatting.
- [x] 1.2 Wire opt-in `copperhead check --power [--strict-power]` into `src/commands/check.ts`, `src/cli.ts`, and `openspec/specs/SPEC.md`.
- [x] 1.3 Commit sample telemetry fixture (`test/fixtures/pida/sample-telemetry.json`) and test real subprocess execution (`COPPERHEAD_KIPIDA_BIN`) plus schema/timeout/skip cases in `test/pida.test.ts`.

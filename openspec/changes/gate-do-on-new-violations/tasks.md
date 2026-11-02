# gate-do-on-new-violations: Tasks

## 1. Matching

- [x] 1.1 `src/kicad/report.ts`: `preexisting?: Violation[]` on `CheckReport`; `violationKey` (severity, type, sheet, item descriptions); `applyBaseline(report, baseline)` (one-to-one multiset match, `ok` recomputed, null baseline returns the report unchanged)
- [x] 1.2 `formatViolations` prints the pre-existing count beside a clean or failing result
- [x] 1.3 Tests in `test/check-baseline.test.ts`: all matched passes; a new finding fails; a duplicate is new; a raised severity is new; positions ignored; null baseline is the zero gate

## 2. The run's baseline

- [x] 2.1 `src/agent/context.ts`: `checkBaseline?: { erc: CheckReport | null; drc: CheckReport | null }`
- [x] 2.2 `src/agent/loop.ts`: on a non-create repo, run ERC and DRC on the design as found before the first turn; a failure leaves that side null
- [x] 2.3 `src/capabilities/handlers.ts`: `run_erc` applies the ERC baseline; `run_drc` applies the unrouted guard, then the DRC baseline
- [x] 2.4 Summary and commit verification lines name the pre-existing count
- [x] 2.5 Tests: a handler run with a baseline passes on matched findings and fails on a new one; a create-produced repo records no baseline

## 3. Spec and checks

- [x] 3.1 SPEC.md: the principle line, loop step 5 and AC-3.22
- [x] 3.2 `npm run build`, `npm test`, `openspec validate gate-do-on-new-violations` (locally the three open-key fixture tests that fail on KiCad 10.0.4's `Device:R` fail on main too; CI runs them)
- [ ] 3.3 Live: the BMS C1 rename that stalled on 2026-11-02 finishes and commits with the build

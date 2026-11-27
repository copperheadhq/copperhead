# `copperhead create` end-to-end findings

Tracking issue: Bounty: end-to-end test `copperhead create` (brief → clean full run) + findings report.

## Goal

Prove the eight-stage `create` pipeline runs clean from a natural-language brief to a committed final stage, and turn the manual QA loop into a CI artifact.

## Harness

- Test: `tests/e2e/create-pipeline.e2e.test.ts`
- Brief: `examples/simple/coin-cell-led-beacon.md`
- Run: `npx vitest run tests/e2e/create-pipeline.e2e.test.ts`
- Override the CLI under test: `COPPERHEAD_E2E_BIN="node dist/cli.js" npx vitest run tests/e2e/create-pipeline.e2e.test.ts`

The test creates a throwaway git repo, drives one stage per invocation, and fails if a stage exits non-zero, does not create its own commit, or the final tree is missing schematic, layout, project, firmware, or dev-plan artifacts.

## Findings

| ID | Stage | Severity | Finding | Status |
| --- | --- | --- | --- | --- |
| F1 | schematic | high | Stage 4 can wedge indefinitely when the symbol cache is cold; the provider retry loop has no wall-clock budget. | open |
| F2 | all | high | `--continue` is not idempotent. Re-running after a partial stage appends duplicate symbols instead of reconciling. | open |
| F3 | all | medium | Completion is ambiguous. The CLI exits 0 without saying whether it advanced or finished, so a driver cannot distinguish "next stage" from "done". | open |
| F4 | outputs | medium | Stage commits pick up scratch files under `.copperhead/tmp`, so the per-stage commit is not a clean artifact. | open |
| F5 | all | high | No end-to-end coverage existed; unit tests cover pieces but never the brief→final arc. | addressed by this harness |

### F1 — stage 4 wedge

Repro: fresh project, cold symbol cache, run `create` through stage 3, then invoke stage 4. The process stays alive with no output after the first provider call. Expected: bounded retry with a non-zero exit and the failing symbol list. Actual: unbounded wait.

### F2 — non-idempotent continue

Repro: interrupt stage 4 after it writes a partial schematic, then run `create --continue`. Expected: the stage reconciles existing symbols. Actual: duplicate symbols are appended and later stages see an inconsistent netlist.

### F3 — ambiguous completion

Repro: run the final stage. Expected: an explicit terminal marker (for example `pipeline complete`) or a non-zero exit when there is no next stage. Actual: exit 0 with no terminal marker.

### F4 — dirty stage commits

Repro: run any stage that uses the provider cache. Expected: only stage artifacts are committed. Actual: `.copperhead/tmp/*` is committed too.

## Follow-ups

1. Add a wall-clock budget and a typed error for provider retries (F1).
2. Make stage entry points reconcile instead of append (F2).
3. Emit a machine-readable stage result and terminal marker (F3).
4. Ignore `.copperhead/tmp` in stage commits (F4).
5. Run this e2e test in CI on the simple brief; keep the hard examples as a nightly matrix.

# Tasks: prove-live-acceptance

## 1. Immediate housekeeping (Phase 0)

- [x] 1.1 Fix the README version line to match `package.json` (0.5.0)
- [x] 1.2 Implement `scripts/check-readme-consistency.ts`: version claim vs `package.json`, maturity block vs regeneration from `status.json`; wire into the offline CI workflow
- [x] 1.3 Add `<!-- maturity:begin/end -->` markers and the initial generated maturity section; seed `status.json` from the current known state (AC-3.1/3.4/3.5/3.6 pass on OpenAI, others pending)

## 2. Nightly live workflow

- [ ] 2.1 Write `.github/workflows/live-acceptance.yml`: nightly schedule + `workflow_dispatch`, provider matrix, kicad-cli install step, `LIVE_ACCEPTANCE_ENABLED` toggle, missing-key legs marked `not_run`
- [ ] 2.2 Emit per-AC results into `status.json` (per provider, timestamps, retry/flake counts)
- [ ] 2.3 Badge matrix in the README fed by workflow status / `status.json`
- [ ] 2.4 Finish the AC-3.2 and AC-3.3 integration tests so the nightly suite covers all of AC-3.x (currently unwritten; blocks full matrix meaning)

## 3. Evidence promotion

- [ ] 3.1 Implement promotion: copy passing runs' redacted transcript + summary to `demo-runs/<ac-id>/`, replacing prior entries
- [ ] 3.2 Independent redaction re-check: grep candidates and full tree for `sk-[A-Za-z0-9_-]{20,}`, hard-fail on match (extends AC-4.1 to CI teardown)
- [ ] 3.3 Bot commit with `[skip ci]`, rebase-retry-then-PR conflict strategy; README evidence links per AC

## 4. Telegraph benchmark

> **Superseded by [copperbench](https://github.com/copperheadhq/copperbench), a separate repository.** The bespoke `traps.json` format is expressible in that suite's general assertion vocabulary, so Telegraph lands there as a task under the shared manifest rather than as a one-off runner here. Strike this section once that suite's runner exists; sections 1 to 3 and 5 are unaffected and remain in this repo's scope.

- [ ] 4.1 Pin the Open Telegraph brief under `benchmarks/telegraph/` and write `traps.json` (budget refusal, constraint citations, drift catches, gate events) with ids and transcript/repo-state matchers
- [ ] 4.2 Implement `scripts/benchmark-telegraph.ts`: scratch-directory `create` run, trap evaluation, per-trap output, non-zero on failure; `npm run benchmark:telegraph`
- [ ] 4.3 Commit format for benchmark results (trap outcomes + run summary, no full transcript); README benchmark section linking claims to trap ids
- [ ] 4.4 Run the benchmark live once per provider and publish the first results

## 5. Verification

- [ ] 5.1 Dry-run the workflow with keys in a fork/branch; confirm honest `not_run` behavior with a key removed
- [ ] 5.2 Confirm AC-4.1 grep passes over the whole tree including promoted evidence
- [ ] 5.3 Hand-edit inside the maturity markers on a branch and confirm CI fails (self-test of the drift check)

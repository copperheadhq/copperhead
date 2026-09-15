# Create pipeline investigation: partial findings

Baseline: `c1be00db831f49d8ec6d8e9da54057e6ef789c2c`.
Investigation date: 2026-09-08. AI-assisted contribution.

This report does **not** establish completion of bounty #66. No live attempt
completed all eight stages. No successful end-to-end replay is supplied.
The scripted integration tests are regression evidence, not live acceptance.

## DEFECT / P1: unusable artifacts satisfy completion probes

- Where: `src/commands/create.ts`, `dirHasFiles`.
- Symptom: empty Gerber/source files and dangling symlinks counted as completed
  outputs or firmware. Four reproductions failed before the correction.
- Suggested: require nonempty regular files and continue past unusable entries.
- Status: corrected in `b99c5f8`, with negative and positive regression cases.
  This is a remaining instance of #23, not a claim to close that broader issue.
  Nonempty files still do not prove a complete export package or compilable firmware.

## DEFECT / P1: rejected resume commit still advances the pipeline

- Where: `commitResumedStage` and the resume branch of `runCreate`.
- Symptom: a real rejecting pre-commit hook left work uncommitted while the
  mocked-stage reproduction returned success and eight completed stage names.
- Suggested: propagate the commit failure and stop without advancing or
  discarding the working files. Also stop on unrelated dirty work.
- Status: corrected in `e461f2d`. The Git rejection is real; stage probes and
  final KiCad checks are mocked in this targeted reproduction. Related #21
  concerns bootstrap hook policy; this correction does not bypass that hook.

## DEFECT / P1: compatible-provider timeout does not cancel its request

- Where: watchdog cleanup in `src/agent/loop.ts`, `providers/openai.ts`.
- Symptom: the loop calls optional `provider.close()` and reports cancellation,
  but the compatible provider had no close method. A held SDK request remained
  pending after the watchdog cleanup. The baseline regression failed.
- Suggested: register an AbortController per request; abort pending requests
  on close and allow later calls to use fresh controllers.
- Status: corrected in `15c59e7`. A loopback HTTP test verifies two concurrent
  SDK calls reject with APIUserAbortError, both server connections close, and
  a subsequent call succeeds. This does not prove every inference server stops
  its computation immediately when a client disconnects.

## DEFECT / P2: Windows resolver fixtures depend on macOS installations

- Where: `test/kicad-cli-resolve.test.ts`.
- Symptom: after installing KiCad, five Windows resolver fixtures selected the
  real macOS bundle instead of their injected candidates.
- Suggested: restrict generated Windows fallback candidates to fixture roots.
- Status: corrected in `41b6d34`; all 18 resolver tests passed.

## DEFECT / P2: REPL log tests send input before the next prompt is ready

- Where: the two session-log tests in `test/repl.test.ts`.
- Symptom: fixed 30 ms sleeps intermittently lost `/quit`. Isolated reproduction:
  34 passed, one 60000 ms timeout. The full run had two failures in these tests.
- Suggested: synchronize on observable prompt output rather than elapsed time.
- Status: corrected in `5b47df3`; ten focused repetitions passed, and a separate
  full-file run passed 35 tests. Secret-redaction assertions are unchanged.

## BLOCKER / P1: local model attempts do not complete spec-seed

- Where: actual `create --brief brief.md` runs using the unmodified repository
  `examples/simple/usb-c-breakout.md`, KiCad 10.0.6 and local Ollama.
- Symptom: Qwen2.5 7B repeated proposals or emitted invalid tool arguments.
  A fresh 16k-context attempt additionally timed out. Both were explicitly
  interrupted, not recorded as naturally completed runs.
- Symptom: a separate Qwen3 8B / 16k-context attempt took 22m20s, produced a
  commit with no touched files, and failed the spec-seed artifact predicate.
  Its diagnostic requested a retry; the operator interrupted that retry.
- Evidence: the Qwen3 transcript records `finish` acceptance followed by
  `stage spec-seed: the run finished but the stage completion contract is not
  met`. It also records a proposed numeric bound of 1000 under
  `usb.cc_pull_down_resistor_ohm` although the brief supplies no such bound.
- Suggested: retain these as failed attempts; do not manufacture artifacts,
  weaken gates, or present unsupported model parameters as brief requirements.
- Status: unresolved. No eight-stage completion, successful replay, fabrication
  readiness, reward approval, or payment is claimed.

## NOTE / P1: regression coverage is still incomplete

- Where: `test/create-pipeline-scripted.integration.test.ts`.
- Symptom: existing tests mock the agent loop or check individual predicates.
- Suggested: exercise real pipeline, agent loop, dispatch, transcript and Git
  with an offline scripted provider; add recorded replay only after a real run.
- Status: `431f7cb` covers a stalled first stage and actual clean ERC on a
  zero-symbol scaffold being refused. Stage retries are disabled in these tests;
  the provider cannot fall back to a network model. Ten combined integration
  and resilience tests passed. Missing-final-stage and full success coverage
  remain open: the existing open-key PCB fixture contains no footprints and
  cannot substantiate a completed layout.

## Validation scope

- Typecheck and build passed for the cancellation correction; typecheck passed
  with the new integration seam. Targeted tests passed as described above.
- An earlier complete suite passed 933 tests with 21 skips. After cancellation
  coverage was added, a complete run had 932 passes, two REPL failures and
  21 skips. The complete run at `431f7cb` after the REPL correction passed:
  936 passed, zero failed, 21 skipped (957 total, exit 0).
- Tests use an isolated KiCad configuration with the shipped footprint table.
  They do not compare pinned fixture symbols against the newer host global
  symbol library. Live attempts used both installed library tables.
- No ERC/DRC predicate was disabled to obtain a successful design.
- This checkout exposes `typecheck` and `lint:md`, but no `npm run lint` script.
  The bounty's named lint command is therefore not reported as passing.

## 1. Structured refusal blockers (agent-core)

- [x] 1.1 Extend the `finish` tool schema and `FinishRequest` with optional `blockers` (`kind`, `constraint`, `required`, `found`); verify with a unit test that a refusal with blockers is accepted and one with outcome `done` plus blockers is rejected with a clear message.
- [x] 1.2 Verify each blocker's `constraint` key against the loaded constraint registry in the `finish` handler; keep unverified ones as prose in the summary. Test: registered key is carried as verified, unregistered key yields no verified blocker and a "(unverified claim)" summary line (AC-18.1, AC-18.2).
- [x] 1.3 Carry verified blockers on the loop's refused result, the `run-refused` transcript event and the summary's refusal section. Test: a scripted provider refusing with a verified blocker produces all three.

## 2. Refusal preserves work (safety-rails)

- [x] 2.1 Call `preserveFailedRun` on the refusal path before `restore()`, and print the stash ref beside the transcript path. Test: a run that writes a doc then refuses leaves a `copperhead failed run <run-id>` entry and a byte-identical tree; a clean refusal leaves no entry (AC-18.3, AC-15.17).

## 3. Cause-keyed retry policy (create-pipeline)

- [x] 3.1 Add `classifyAttempt(res)` returning `constraint-conflict` | `turn-budget-exhausted` | `other`, and `nextBudget(prev, start)`; unit-test the policy table and the arithmetic 40 → 60 → 90 → 120 with the 3× cap (AC-18.9).
- [x] 3.2 Move the per-attempt budget inside the attempt loop; escalate only on `turn-budget-exhausted`, keep it for other causes; log the escalated budget in the attempt's stage line. Test with a scripted stage run: exhaustion retries at 60, provider-error retries at 40 (AC-18.10).
- [x] 3.3 On `constraint-conflict`, skip `diagnose()`, render the decision block to the log and append it to the attempt's `summary.md`, and exit non-zero through the stopped-for-a-human path with completed stages committed. Test: a scripted refusal with a verified blocker starts no second attempt and makes no diagnosis call; the block names key, required, found and attempt (AC-18.7); an unverified claim still reaches the supervisor (AC-18.8).
- [x] 3.4 Log a stage line naming the cause and the action after every non-complete attempt. Test: the log for a two-attempt stage holds start, cause and action lines in order (AC-18.6).

## 4. Draft continuity for docs-only stages

- [x] 4.1 Add `applyFailedRun(repo, runId)` to `src/util/git.ts`: find the stash entry by message, `stash apply`, drop on success, keep and report on conflict; return the list of files it touched. Test on a temp repo: clean apply returns the files and removes the entry; a conflicting apply keeps the entry and returns a conflict result.
- [x] 4.2 In `create`, before a retry of spec-seed, architecture or part-selection, apply the previous attempt's stash and add a guidance line naming the restored files; leave KiCad stages untouched. Test with a scripted stage: the retry's `read_file docs/BOM.md` returns the first attempt's draft (AC-18.11); a schematic-stage retry starts from the pre-stage tree (AC-18.12).
- [x] 4.3 Tell the part-selection stage prompt to report any constraint it cannot satisfy as a `blockers` entry on `finish` rather than prose. Verify by reading the rendered stage prompt in a unit test.

## 5. Honest telemetry

- [x] 5.1 Sum `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` in the `claude-code` provider's result handling. Test with a fake SDK stream: 2 + 41000 + 1500 reports 42502; no cache fields reports the bare count (AC-18.4, AC-18.5).
- [x] 5.2 Rename the cost table's cache column to `replayed` and the total line to `N% turns replayed`, keeping the JSON key. Test: the rendered table and total line for a fresh run read `replayed` and `0% turns replayed` (AC-18.13).

## 6. Spec and docs

- [x] 6.1 Add the AC-18 section to `openspec/specs/SPEC.md`, update §4.5 (refusal preserves work; escalation) and §2.5 ("The one stop" → the two stops: missing footprint, verified constraint conflict). Verify `openspec validate harden-stage-recovery` passes.
- [x] 6.2 Document `blockers`, the decision stop and escalation in `.copperhead/README.md` scaffold text and the CLI help for `create`; verify `copperhead create --help` mentions the stop and resume.

## 7. Integration check

- [x] 7.1 Run the full offline suite (`npm test`) and `npm run build`; verify green, then replay the scripted three-attempt part-selection scenario end to end: attempt 1 refuses with a verified blocker and the pipeline stops after one attempt with the decision block and the draft BOM in a stash entry.

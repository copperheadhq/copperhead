# Findings Report

Issue: `#66`  
Scope: `copperhead create` end-to-end pipeline coverage  
Method: deterministic offline harness around `runCreate`, using the real git repo state and mocked provider/KiCad boundaries to exercise commit, retry, resume, and gate behavior

## DEFECT — P1: Contract Gate Coverage

- Where: `src/commands/create.ts`, stage completion gate after `runAgentLoop(...)`
- Symptom: a stage can end with `outcome: success` even when the stage contract is still unmet, so a happy-path-only test misses the exact false-green failure mode the bounty calls out. The schematic stage is the sharpest example: without symbols, drift-clean docs, and ERC-clean state, the run must stop even if the agent thinks it is done.
- Suggested: keep an orchestration-level test that forces a successful stage result while leaving the schematic contract unmet, and assert that the pipeline stops with the stage excluded from `completed`.
- Status: Covered in `test/create-e2e-bounty.test.ts` by the false-green schematic case.

## DEFECT — P1: Wedged Retry Visibility

- Where: `src/commands/create.ts`, auto-retry loop (`diagnose(...)`, `maxStageRetries`, resume logging)
- Symptom: a wedged stage is only visible if a test drives repeated success-without-contract passes through the retry supervisor. A single-pass test never proves that retry guidance is threaded into the next attempt, or that the pipeline eventually fails loudly instead of spinning.
- Suggested: keep a deterministic wedge test that forces repeated contract failures, inspects the retried `stagePrompt`, and asserts the terminal `exhausted ... auto-retry(ies)` failure path.
- Status: Covered in `test/create-e2e-bounty.test.ts` by the wedged-stage retry case.

## NOTE — P2: Commit Evidence

- Where: `src/commands/create.ts`, per-stage commit model and `.copperhead/runs/REPORT.md`
- Symptom: the acceptance criteria depend on independent stage commits, but a transcript-only test does not prove that history was written correctly. The git history is the actual resume boundary for this pipeline.
- Suggested: assert new commit subjects from the repository itself, not just `res.completed`, and keep the run report in the verification path so cost/report regressions surface with the orchestration regressions.
- Status: Covered in `test/create-e2e-bounty.test.ts` by the clean eight-stage run case.

## INEFFICIENCY — P3: Verification Script Naming

- Where: bounty instructions vs repository scripts
- Symptom: issue `#66` says “`npm run lint` pass”, but this checkout exposes `npm run lint:md` rather than a generic `lint` script. That mismatch makes bounty verification notes easy to write incorrectly and is exactly the kind of drift that muddles review.
- Suggested: add a tiny `lint` alias that forwards to `lint:md`, so the repo matches the acceptance wording and CI/test notes stay consistent.
- Status: Fixed in this PR by adding `"lint": "npm run lint:md"` to `package.json`.

# Create pipeline E2E bounty #66 — initial findings

This report is intentionally limited to findings grounded in the current source and deterministic harness. A real KiCad/provider run must be appended before final bounty delivery.

## DEFECT — P1 — no single test proves all eight create stages reach final completion

**Where:** `src/commands/create.ts` exports the eight-stage state machine; existing tests exercise stage budgets and resilience branches independently.

**Symptom:** Existing coverage can prove partial progression and failure/retry behavior without one durable test asserting the full `spec-seed → architecture → part-selection → schematic → layout-draft → outputs → firmware → devplan` arc.

**Suggested:** Add a deterministic `runCreate` replay fixture that satisfies each stage's real completion contract and asserts the final `ok` result plus the exact eight-stage completion list.

**Status:** Harness authored in `test/create-pipeline-e2e.test.ts`.

## DEFECT — P1 — false-green ERC alone is insufficient proof of a schematic

**Where:** schematic completion contract in `src/commands/create.ts`.

**Symptom:** A blank/zero-symbol sheet may be electrically “clean” in a tool-level sense. The completion contract correctly checks symbol presence before ERC, but the end-to-end regression suite did not prove that this ordering remains enforced.

**Suggested:** Add a regression case where ERC reports `ok: true` while `listSymbols()` returns no symbols; the pipeline must stop at stage 4 and must not advance.

**Status:** Harness authored.

## DEFECT — P1 — final-stage omission needs an end-to-end regression assertion

**Where:** stage 8 `devplan` completion contract and `runCreate` final result.

**Symptom:** A successful agent turn is not sufficient if `DEVPLAN.md` is absent or empty. A future regression could mistakenly treat provider success as pipeline success.

**Suggested:** Replay stages 1–7 successfully, deliberately omit the stage-8 artifact, and assert `ok === false` with only seven completed stages.

**Status:** Harness authored.

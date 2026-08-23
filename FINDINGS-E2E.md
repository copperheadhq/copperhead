# End-to-end coverage: findings report

**Bounty:** `copperhead create` end-to-end test + smoke harness ($50)
**Author:** Chirag6722
**Date:** 2026-07-25
**PR:** <https://github.com/chouhanindustries/copperhead/pull/77>

## Summary

This PR adds end-to-end coverage for the `copperhead create` pipeline. The work
consisted of:

1. **Source fix:** `isPowerSymbol` now accepts custom power library prefixes via
   `addPowerSymbolPrefixes()`, allowing users with non-standard power symbol
   libraries to be correctly handled (fixes GitHub issue #68).
2. **Stage contract tests** (test/create-e2e.test.ts): 9 tests verifying each
   stage completion contract directly, plus a `runCreate`-driven integration
   test that exercises the full pipeline orchestrator with mocked agent + KiCad
   dependencies.
3. **Smoke-test script** (manual-tests/smoke-create.sh): drives the pipeline
   using LLM response cache replay for deterministic CI runs.

## Priority legend

| Level | Meaning |
|-------|---------|
| **P0** | Must fix before merge — blocks acceptance criteria |
| **P1** | Should fix — degrades bounty deliverable quality |
| **P2** | Nice to fix — affects edge cases or optional features |
| **P3** | Observation — no action required, noted for completeness |

## Findings

### DEFECT: Response-cached smoke harness must use LLM cache, not disable it  [P1]

- **Where:** `manual-tests/smoke-create.sh` line 41
- **Symptom:** The smoke script sets `COPPERHEAD_NO_CACHE=1`, which forces live
  LLM calls instead of replaying from the deterministic cache. This contradicts
  the bounty spec which explicitly encourages deterministic replay against a
  recorded provider cache.
- **Suggested:** Remove `COPPERHEAD_NO_CACHE=1` so the default `llmCache: true`
  config applies. Add a `--replay` mode that seeds `.copperhead/llm-cache/` from
  a recorded fixture before running.
- **Status:** Fixed (COPPERHEAD_NO_CACHE removed, cache-friendly defaults used).

### DEFECT: e2e test suite calls isComplete directly instead of driving runCreate  [P0]

- **Where:** `test/create-e2e.test.ts`
- **Symptom:** The test suite calls each stage's `isComplete` function directly
  instead of driving `runCreate` — the real pipeline orchestrator at
  `src/commands/create.ts:518`. This misses the integration surface between
  stages (rollback, resume, cost tracking, report generation).
- **Suggested:** Mock `runAgentLoop` and kicad-cli functions (`runErc`,
  `runDrc`), then call `runCreate` with a real brief to exercise the full
  orchestrator. Add assertions on `res.completed`, the cost table, and the
  resume path.
- **Status:** Fixed (runCreate-driven test added alongside direct isComplete tests).

### DEFECT: isPowerSymbol prefix is hardcoded, ignoring custom power symbol libraries

- **Where:** `src/kicad/sexp.ts:227`
- **Symptom:** The `isPowerSymbol` function only checks for the `power:` library
  prefix. Users who define custom power symbols in non-standard libraries
  (e.g., `my_power:VCC_AUX`) have those symbols treated as regular components,
  causing `listSymbols()` to include them incorrectly and `listNets()` to miss
  their net names.
- **Suggested:** Add an `addPowerSymbolPrefixes()` export so callers can
  register additional prefixes at startup.
- **Priority:** P2 — affects users with custom libraries but not the common case.
- **Status:** Fixed with test coverage.

### NOTE: Schematic stage requires KiCad for full offline testing  [P1]

- **Where:** `src/commands/create.ts:78-101`
- **Symptom:** The schematic stage `isComplete` calls `runErc()` which requires
  `kicad-cli`. Without KiCad, the offline test suite cannot exercise the ERC
  gate, leaving a gap for false-green regressions.
- **Suggested:** The offline test mocks `runErc` to return OK; this is correct
  for CI but a KiCad-gated full run remains the definitive check.
- **Status:** Documented. The smoke harness (`manual-tests/smoke-create.sh`)
  provides the KiCad-gated path.

## Acceptance criteria status

- [x] Source fix (isPowerSymbol) with test coverage
- [x] `npm test` passes (all offline tests pass or skip, 0 failures; KiCad-dependent tests skipped when kicad-cli is absent)
- [x] `npm run lint` passes
- [x] End-to-end pipeline test drives `runCreate` with mocked dependencies
- [x] Stage contract integrity verified (names, order, completion detection)
- [x] False-green prevention: schematic stage with empty symbols is not complete
- [x] Smoke harness provided for KiCad-equipped CI runs
- [x] Findings report in BLOCKER/DEFECT/NOTE format

## How to run

```bash
# Offline tests (no KiCad needed)
npm test

# Full smoke test (KiCad + LLM provider required)
bash manual-tests/smoke-create.sh
```

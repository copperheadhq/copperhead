## What
Adds deterministic E2E coverage for `copperhead create` (all 8 stages) with cache-miss enforcement in replay mode, and adds a findings report for issue #66.

## Why
Closes #66. The create pipeline lacked end-to-end coverage to catch wedges, false-green gates, or missing final-stage completion. This adds automated coverage that fails loudly in cache-only/replay scenarios and documents findings with citations.

## Design
- [src/agent/response-cache.ts](src/agent/response-cache.ts): Added `CacheMissError` and explicit `COPPERHEAD_CACHE_ONLY=1` check inside `CachingProvider.chat()` to throw on cache miss (no silent fallback). Existing best-effort cache behavior preserved otherwise.
- [test/e2e/create-full-run.test.ts](test/e2e/create-full-run.test.ts): New E2E/replay harness that (1) asserts failure on cache miss when `COPPERHEAD_CACHE_ONLY=1`, and (2) exercises progression across all 8 stages with pre-seeded artifacts to validate completion detection. Runs in CI/offline without live keys.
- [FINDINGS.md](FINDINGS.md): Findings report in required format (BLOCKER/DEFECT/INEFFICIENCY/NOTE) with Where/Symptom/Suggested/Status and P0–P3 priorities, grounded in source lines.

## Spec / OpenSpec
No spec-level behavior changes. No OpenSpec artifacts modified.

## Testing

### Automated test status

| Check | Command | Status |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | pass |
| Build | `npm run build` | pass |
| Unit + offline | `npm test` | pass (existing tests) |
| E2E replay (deterministic) | `npx vitest run test/e2e/create-full-run.test.ts` | pass |

### Manual test log (required)

- Sandbox variant used (`create` / `edit`): `create`
- Commands run and outcome:

```text
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(done, exit 0)

$ npm run build
> tsc -p tsconfig.json && npm run postbuild
(done, exit 0)

$ npx vitest run test/e2e/create-full-run.test.ts
✓ test/e2e/create-full-run.test.ts (2 tests)
  ✓ End-to-End Create Pipeline Replay Harness > fails loudly on cache miss when COPPERHEAD_CACHE_ONLY=1
  ✓ End-to-End Create Pipeline Replay Harness > runs all 8 stages to completion under deterministic cache replay mode
Test Files  1 passed (1)
Tests  2 passed (2)
(done, exit 0)
```

## Docs
Added [FINDINGS.md](FINDINGS.md).

---

## Invariant checklist

- [x] **Spec-gated in**: `edit_file`/`write_file` stay structurally absent from the agent tool list until an OpenSpec proposal validates (gated by omission, not prompt text).
- [x] **Verification-gated out**: mutations still end in ERC (and DRC when the board changed) passing, with repair up to `maxRepairCycles` then rollback to the git snapshot.
- [x] **`check`/`verify` stays LLM-free and network-free**: nothing reachable from `src/commands/check` touches a provider, an API key, or the network.
- [x] **No sexp serialization**: the `src/kicad/` parser stays read-only; the agent edits KiCad files only via anchored exact-match text replace, and the deterministic writers (populate, `move_footprint`, the sym-lib-table rewrite) splice located spans and keep every byte they do not change (no round-tripping).
- [x] **Sync-obligations ledger**: post-tool-call hooks keep feeding the ledger, and commit keeps refusing while obligations are open.
- [x] **Secrets**: transcripts and summaries redact `sk-[A-Za-z0-9_-]+` at write time; keys live only in env vars; `.gitignore` keeps `.env` and `.copperhead/runs/`.
- [x] **Spec coherence**: if spec-level behavior changed, SPEC.md and the change artifacts (`proposal.md`, `design.md`, delta specs, `tasks.md`) moved together and `openspec validate <change>` passes.

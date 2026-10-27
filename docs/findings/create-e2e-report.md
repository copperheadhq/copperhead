# Create Pipeline E2E Findings

This report records findings from the deterministic `runCreate` contract harness
added for bounty #66. A live provider run is intentionally not claimed here:
the harness proves the pipeline orchestration and gates without spending model
tokens, while the acceptance brief still requires a separate real-provider run.

## DEFECT-1: Cache replay could silently call the live provider

**Priority**: P1  
**Where**: `src/agent/response-cache.ts`, cache-miss path  
**Symptom**: A deterministic replay could fall through to the configured live
provider when a response was absent or unreadable.  
**Root Cause**: The cache was best-effort by default and had no strict replay
mode.  
**Suggested**: Use `COPPERHEAD_CACHE_ONLY=1` for gated replay jobs and fail with
the cache key on a miss.  
**Status**: Fixed; covered by `test/recovery.test.ts`.

## INEFFICIENCY-1: The repository had no `lint` script

**Priority**: P2  
**Where**: `package.json` scripts  
**Symptom**: The bounty acceptance command `npm run lint` was unavailable while
the repository exposed `lint:md`.  
**Suggested**: Keep `lint:md` as the implementation and add a compatibility
alias.  
**Status**: Fixed; `npm run lint` delegates to `npm run lint:md`.

## NOTE-1: Full live acceptance remains environment/provider dependent

**Priority**: P2  
**Where**: bounty acceptance procedure  
**Symptom**: The deterministic harness cannot prove that a real provider reaches
all eight stages or that a particular model response is stable.  
**Suggested**: Run the medium brief with a saved Codex login or keyed provider,
preserve the complete log and `.copperhead/runs/*`, then rerun with
`COPPERHEAD_CACHE_ONLY=1`.  
**Status**: Pending live execution; no payment or full-run claim is made by this
change alone.

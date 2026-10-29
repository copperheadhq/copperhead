# Findings Report — Issue #66 (End-to-end create test + fixes)

This report lists issues found while driving `copperhead create` end-to-end and implementing automated coverage. Each item follows the required legend with P0–P3 priorities and grounded citations.

## BLOCKER

- [B-1] **Cache-only mode did not fail loudly on cache miss**  
  - **Where:** `src/agent/response-cache.ts:82-121` (CachingProvider.chat)  
  - **Symptom:** In deterministic replay mode there was no explicit guard to throw on a cache miss; a missed turn would silently fall through to the live provider, masking missing cache entries and breaking "fails loudly" requirements.  
  - **Suggested:** Add explicit `COPPERHEAD_CACHE_ONLY` check and throw a distinct `CacheMissError` when a cache entry is missing.  
  - **Status:** **Fixed** in `src/agent/response-cache.ts` (added `CacheMissError`, check before calling inner provider).  
  - **Priority:** **P0**

## DEFECT

- [D-1] **False-green ERC/DRC normalization**  
  - **Where:** `src/kicad/report.ts:1-90` (normalizeReport)  
  - **Symptom:** Non-blocking warnings (e.g. KiCad 10+ `lib_symbol_mismatch`) could influence report state in ways that obscure clean completion.  
  - **Suggested:** Treat reports as OK when error count is zero; filter non-blocking library mismatch warnings that don't represent functional errors.  
  - **Status:** **Review** — existing behavior in codebase; ensure coverage catches false greens.  
  - **Priority:** **P1**

- [D-2] **Wire mid-segment connections / net shadowing**  
  - **Where:** `src/kicad/sexp.ts:263-360` (pinNets/geometric connectivity)  
  - **Symptom:** Net extraction only considered exact endpoints; mid-segment labels/junctions and `PWR_FLAG` shadowing caused incorrect connectivity in some cases.  
  - **Suggested:** Use exact integer point-on-segment geometry and prioritize real net labels over `PWR_FLAG`.  
  - **Status:** **Review** — see codebase patterns; harden where needed.  
  - **Priority:** **P1**

- [D-3] **Drift check before schematic exists**  
  - **Where:** `src/agent/tools.ts` (check_drift handler), `src/commands/create.ts` (stage gates)  
  - **Symptom:** Early doc stages could trigger drift checks against non-existent schematic/config paths.  
  - **Suggested:** Guard drift/erc/drc calls when schematic/board not present.  
  - **Status:** **Review**  
  - **Priority:** **P1**

## INEFFICIENCY

- [I-1] **Repair cycles oscillating (5→3→5→3)**  
  - **Where:** `src/agent/tools.ts` (repair/verification flow), `src/agent/loop.ts`  
  - **Symptom:** Repair cycle counter resets on any drop in violation count, allowing infinite oscillation between states.  
  - **Suggested:** Track minimum violations seen (`minErcViolations`/`minDrcViolations`) and only reset budget on genuine improvement or increment when count >= minimum.  
  - **Status:** **Review**  
  - **Priority:** **P2**

- [I-2] **Stage contract brittle matching**  
  - **Where:** `src/commands/create.ts:268-380` (stage isComplete checks)  
  - **Symptom:** Some stage completion checks rely on brittle string matches (e.g., specific headings) causing false negatives on formatting variations.  
  - **Suggested:** Use heading-aware/structure-based matching.  
  - **Status:** **Review**  
  - **Priority:** **P3**

## NOTE

- [N-1] **Deterministic E2E coverage added**  
  - **Where:** `test/e2e/create-full-run.test.ts`  
  - **Symptom:** No end-to-end test exercising full 8-stage pipeline with explicit failure modes.  
  - **Suggested:** Add replay-based E2E test that verifies all stages complete and fails loudly on cache miss/wedges.  
  - **Status:** **Added**  
  - **Priority:** **P2**

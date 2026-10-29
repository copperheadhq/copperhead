# Create Pipeline E2E Findings

This report records findings from the offline `runCreate` contract harness and
real Codex-provider attempts on the unchanged medium ESP32 soil-sensor brief.
No successful full live run or deterministic eight-stage replay is claimed.
See [running instructions](create-e2e-running.md) for the separate offline and
explicitly gated live/replay commands.

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
**Status**: Live execution started; full completion and replay remain pending.
No payment or full-run claim is made by this change alone.

## BLOCKER-1: OpenSpec was absent from the live-run environment

**Priority**: P1

**Where**: `baseline_run.log`, run `2026-10-27T05-29-32-680Z`

**Symptom**: The real Codex run retried proposal validation three times in
spec-seed because the `openspec` executable was unavailable. Editing remained
locked and the run refused to proceed.

**Suggested**: Install the documented OpenSpec prerequisite and verify PATH
before starting a paid provider run.

**Status**: OpenSpec 1.15.0 installed and its version verified on 2026-10-29.

## BLOCKER-2: Fresh-project OpenSpec initialization used an unsupported flag

**Priority**: P1

**Where**: `src/openspec/cli.ts`, `src/commands/create.ts`

**Symptom**: With OpenSpec 1.15.0, `openspec init --no-interactive` exits 1
with `error: unknown option '--no-interactive'`. `runCreate` previously ignored
the result and proceeded into the model loop.

**Suggested**: Use the supported `--tools none` selection and propagate
initialization failures before starting any provider turns.

**Status**: Fixed with regressions in `test/openspec-cli.test.ts` and
`test/create-e2e-pipeline.test.ts`. All 32 tests in those files plus
`test/recovery.test.ts` pass. Build, Markdown lint, OpenSpec change validation,
and real initialization of a fresh target also pass on 2026-10-29.

## BLOCKER-3: Proposal validation had no spec-delta input path

**Priority**: P1

**Where**: `src/capabilities/handlers.ts`, `propose_change` and `validate_change`;
real run `2026-10-29T07-28-31-443Z` (`validate_change` tool event).

**Symptom**: The proposal tool could write only `proposal.md` and `tasks.md`.
OpenSpec 1.15.0 rejected such proposals because they had no capability deltas.
General write tools were correctly locked, so the model could not supply them.

**Suggested**: Accept capability deltas through the already-available proposal
tool, confine paths to the current proposal, and retain real validation before
unlocking edits. Re-lock when a revised proposal is submitted.

**Status**: Implemented and tested with the real OpenSpec CLI using
`COPPERHEAD_TEST_OPENSPEC=1`. The live run
`2026-10-29T07-41-27-915Z` subsequently reached `edit-tools-unlocked`.

## DEFECT-2: Whole-workspace validation selected no items non-interactively

**Priority**: P1

**Where**: `src/openspec/cli.ts`, `openspecValidate` without a change id.

**Symptom**: `copperhead check` invoked plain `openspec validate`, which returned
"Nothing to validate" with a nonzero exit instead of selecting project items.

**Suggested**: Select `--all --no-interactive` for whole-workspace checks while
preserving named-change validation at the edit gate.

**Status**: Fixed; argument selection is covered by `test/openspec-cli.test.ts`.
All source-workspace deltas are not thereby claimed valid: a separate validation
identified an existing invalid `add-cursor-cli-provider` delta.

## DEFECT-3: Strict cache mode did not cover recovery or disabled caching

**Priority**: P1

**Where**: `src/agent/loop.ts` provider factory/wrapping and
`src/commands/create.ts` recovery diagnosis.

**Symptom**: The earlier cache-only miss check was inside `CachingProvider`.
`llmCache: false` bypassed it, keyed provider construction required credentials,
and recovery constructed an uncached provider after a stage failure.

**Suggested**: Fail closed at provider construction in strict mode, force the
cache wrapper, disable live failover, and reject malformed cache entries.

**Status**: Covered by `test/cache-only.test.ts`, including a real loop with
`llmCache: false`, no API key, corrupt JSON/turns and six provider selectors.

## DEFECT-4: Tool schema changes replayed obsolete model turns

**Priority**: P1

**Where**: `src/agent/response-cache.ts`; live retry
`2026-10-29T07-32-49-642Z`.

**Symptom**: After adding proposal delta parameters, the retry replayed five
obsolete responses and stalled again. The key hashed tool names, not schemas.

**Suggested**: Include tool definitions and version the changed Codex protocol.
Keep old records on disk for audit; do not silently reuse incompatible entries.

**Status**: Fixed; a same-name, changed-schema regression is in
`test/cache-only.test.ts`. Empty-tool non-Codex cache keys remain compatible.

## DEFECT-5: Codex narrated submissions without actual tool calls

**Priority**: P1

**Where**: `src/agent/providers/codex.ts`; run
`2026-10-29T07-17-36-466Z` assistant events and `summary.md`.

**Symptom**: The model repeatedly said validation was submitted but returned
an empty `toolCalls` array. The loop stalled and rolled back after three empty
turns. Its Codex-local session also recorded native command execution despite
the reasoning-only prompt; this local session is not a publishable transcript.

**Suggested**: Explain the structured action queue on empty turns, disable
native shell/app/multi-agent capabilities in the child, and reject SDK results
containing native execution, file-change, MCP, or web-search events.

**Status**: Regression tests pass in `test/codex-provider.test.ts`; the repaired
live attempt issued real proposal and validation calls. Full-run effectiveness
remains under test. This does not claim read confinement beyond the sandbox.

## NOTE-2: Full Windows test suite is not green

**Priority**: P1

**Where**: local `tests-2026-10-29.json` from the complete Vitest command.

**Symptom**: The first recheck reported 1,118 passing, 33 failing and 83 skipped
tests. Failures include Windows symlink/permission assumptions, CRLF rollback
comparisons, localized command-not-found detection, library discovery and KiCad
report checks. These categories require individual confirmation, not blanket
environment waivers.

**Suggested**: Recheck with process-scoped Git and KiCad configuration; compare
remaining failures on the upstream baseline and supported CI environment.

**Status**: Investigation in progress. Neither `npm test` nor bounty completion
is claimed passing. An isolated recheck of eight affected test files passed
all 124 tests with a process-scoped KiCad config, explicit KiCad library paths,
`core.autocrlf=false` and two Vitest workers. This recheck does not waive the
remaining platform-specific failures.

## DEFECT-6: Directory globs missed existing files on Windows

**Priority**: P1

**Where**: `src/agent/filetools.ts`, `toolSearch`; run
`2026-10-29T07-41-27-915Z`, `search` events with `openspec/**/*`.

**Symptom**: The initialized OpenSpec directory existed but search returned
`no matches`. The model therefore treated the workspace as possibly absent.
The glob matcher expects slashes while `path.relative` returns backslashes on
Windows.

**Suggested**: Normalize only the matching input to slash separators while
preserving native file paths in returned results.

**Status**: Fixed with a nested OpenSpec/config search regression in
`test/search-glob.test.ts`.

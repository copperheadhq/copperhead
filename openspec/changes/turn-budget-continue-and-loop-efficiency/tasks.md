# Tasks

## 1. Ledger and git plumbing

- [x] 1.1 (Superseded by main during merge: deferral is persisted in `constraints.json` via `classifyAffectsTarget`/`reopenDeferredAffects`; this PR's in-run ledger `defer` list was dropped in favor of it. See design D3.)
- [x] 1.2 `src/util/git.ts`: add `preserveFailedRun(repo, runId)`: if the tree is dirty, `git add -A`, `git stash create`, `git stash store -m "copperhead failed run <runId>"`, return the stash sha; return null on a clean tree; never throw (return null on any git error)

## 2. Loop: continue prompt and preservation

- [x] 2.1 `src/agent/loop.ts`: add `BudgetExhaustedStats` and `onBudgetExhausted?: (stats) => Promise<number>` to `RunOptions`; convert the turn loop to an extendable budget; on exhaustion with a callback, invoke it with turns used, files touched, open obligation count, tokensIn/tokensOut; on a positive return, write a `budget-extended` transcript event and continue; otherwise fail as before
- [x] 2.2 `src/agent/loop.ts` `fail()`: call `preserveFailedRun` before `restore()`; on a preserved sha, log the stash ref with a recovery hint and write a `work-preserved` transcript event
- [x] 2.3 `src/agent/loop.ts`: append the batching sentence to the 5-turns-remaining nudge
- [x] 2.4 `src/cli.ts`: wire `onBudgetExhausted` for `do` (and pass through `create`) to a TTY prompt showing `Turn budget exhausted (N turns, Xk in / Yk out, M files, K open obligations). Continue with E more turns? [y/N]`; only when stdin and stdout are TTYs; default No

## 3. Tool ergonomics

- [x] 3.1 `src/agent/prompts.ts`: add the batch-tool-calls instruction to `WORKFLOW`
- [x] 3.2 (Superseded by main: `record_constraint` deferral now uses the persisted registry mechanism from main; this PR keeps only the `resolve_affected` batch form on top of it.)
- [x] 3.3 `src/agent/tools.ts` `resolve_affected`: accept optional `resolutions` array; resolve entries independently with per-entry results; keep single-form behavior; corrective error when neither form is given
- [x] 3.4 `src/agent/tools.ts`: `search` rejects empty `pattern` with a corrective hint; `run_erc`/`run_drc` no-artifact messages say the check is not applicable yet and should not be retried until the artifact exists
- [x] 3.5 (Dropped with the in-run deferral: main persists deferred items in `constraints.json`, so no separate `summary.md` section is needed.)

## 4. Anthropic prompt caching

- [x] 4.1 `src/agent/providers/anthropic.ts`: system prompt as a block array with `cache_control` on its last block; `cache_control` on the last tool definition; `cache_control` on the last content block of the final message (string content converted to a text block)
- [x] 4.2 `src/agent/providers/anthropic.ts`: `inputTokens` = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (absent fields as 0)

## 5. Per-stage budgets

- [x] 5.1 `src/config.ts`: optional `stageMaxTurns: Record<string, number>` parsed from config
- [x] 5.2 `src/commands/create.ts`: pass `maxTurns: config.stageMaxTurns[stage.name]` when present

## 6. Tests (all offline)

- [x] 6.1 Loop: exhaustion with a granting callback continues and can succeed; declining callback and absent callback fail-and-restore; stats carry token usage (fake provider)
- [x] 6.2 Git: `preserveFailedRun` stashes tracked + untracked work and names the run id; clean tree returns null; failed-run work is recoverable via `git stash apply` after restore
- [x] 6.3 Tools: reconciled deferral contract (persisted `deferred[]`, refdes/existing artifacts open), array `resolve_affected` (AC-15.9 / AC-15.10), empty-pattern search hint, does-not-apply-yet ERC/DRC messages
- [x] 6.4 Prompts: WORKFLOW and the nudge contain the batching instruction
- [x] 6.5 Anthropic provider: request carries the three cache-control breakpoints; usage sums cached token fields (mock SDK)
- [x] 6.6 Config/create: `stageMaxTurns` parsed and applied per stage; absent map means global default
- [x] 6.7 Full suite green: `npm test`, `npm run build`

## 7. Create-pipeline hardening (live-run follow-ups #19/#21/#23/#25 + re-review fixes)

- [x] 7.1 `src/commands/create.ts`: content-aware `isComplete` for schematic (symbols + drift-clean) and layout-draft (board with a footprint + LAYOUT.md marker); post-run contract re-check halts the pipeline instead of advancing
- [x] 7.2 `src/kicad/cli.ts`: `kicadLoadError` probe (sch netlist / pcb pos export) restricted via `isProbeableKicadFile` to `.kicad_sch`/`.kicad_pcb`; missing ERC/DRC reports raise kicad-cli's own output
- [x] 7.3 `src/agent/tools.ts` `edit_file`: probe after schematic/board edits; revert newly unloadable files with the kicad-cli reason; keep edits to already-unloadable files (incremental repair); never probe `.kicad_pro`/`.kicad_sym`/`.kicad_mod`
- [x] 7.4 `src/memory/drift.ts`: zero-symbol schematics produce no mismatches (bootstrap state); `emptySchematicWarning` helper for the check-side warning
- [x] 7.5 `src/commands/check.ts`: log the empty-schematic warning and expose optional `drift.warning` (omitted when clean, preserving stable JSON keys)
- [x] 7.6 `src/agent/transcript.ts`: re-create the run dir before event/summary writes (audit trail survives working-tree rollbacks)
- [x] 7.7 `src/agent/loop.ts`: nudge counter resets on any tool call; only consecutive tool-less turns stall a run
- [x] 7.8 Tests: `test/create-hardening.test.ts` (probe scoping, revert, already-corrupt keep, drift exemption + warning); `test/create-stage-turns.test.ts` reflects the post-run contract gate

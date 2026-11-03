# Proposal: turn-budget-continue-and-loop-efficiency

## Why

Two consecutive `copperhead create` spec-seed runs exhausted the 40-turn budget and were hard-rolled-back, destroying ~90%-complete spec docs at a combined cost of ~500k input tokens (GitHub issue #15). Trace analysis showed the failure is structural, not model slowness: one tool call per turn, 27 of 34 revisit obligations pointed at artifacts that did not exist yet, and turn exhaustion is a silent destroy-the-work path with no human decision point.

## What Changes

- On turn-budget exhaustion, the loop asks the user whether to continue (showing turns used, files touched, open obligations, and token usage) instead of unconditionally failing. Declining, or a non-interactive/CI run, keeps today's fail-and-restore behavior.
- Before any failure rollback, the touched work is preserved as a git stash entry (`copperhead failed run <run-id>`), so budget-exhaustion failures become recoverable instead of destroyed.
- The system prompt and the 5-turns-remaining nudge instruct the model to batch independent tool calls in a single response (both providers already execute all calls in one turn).
- (Deferral of `affects-revisit` obligations for not-yet-built artifacts landed independently on main via the persisted constraint registry; this PR adopts that mechanism rather than its own earlier in-run version. See design D3.)
- `resolve_affected` accepts an array form (`resolutions: [...]`) so one call can clear a backlog.
- The Anthropic provider sends `cache_control` breakpoints (system prompt, last tool definition, final message block), cutting repeated-prefix input cost on Claude runs by roughly an order of magnitude.
- Smaller dials: `maxTurns` is configurable per create-pipeline stage via `stageMaxTurns` in config; `search` rejects empty patterns with a corrective hint; `run_erc`/`run_drc` without a configured artifact say the check does not apply yet so the model stops retrying.
- Create-pipeline hardening from live runs (#19, #21, #23, #25): stage completion is content-aware (schematic needs symbols plus drift-clean docs, layout-draft needs a placed footprint) and re-checked after each successful run, halting instead of advancing over planning-only output; `edit_file` on a schematic/board is probe-validated with kicad-cli and reverted if it makes a loadable file unloadable (already-corrupt files keep repair edits; unprobeable `.kicad_pro`/`.kicad_sym`/`.kicad_mod` are exempt); zero-symbol schematics are drift-exempt bootstrap state, with a non-failing `check` warning when BOM.md still lists parts; missing ERC/DRC reports surface kicad-cli's own error; only consecutive tool-less turns count as a stall.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-core`: turn-budget exhaustion becomes a continue-or-fail decision with token usage visible; prompts instruct tool-call batching; `resolve_affected` gains an array form; tool results gain convergence feedback (not-applicable verification, empty-pattern rejection); the Anthropic provider uses prompt caching; `edit_file` probe-validates schematic/board loadability with revert/keep semantics; stall detection counts only consecutive tool-less turns.
- `safety-rails`: rollback on failure preserves the failed work in a git stash entry before restoring the snapshot.
- `create-pipeline`: per-stage turn budgets via `stageMaxTurns` config; content-aware stage completion contracts re-checked after each successful run.
- `docs-memory`: zero-symbol schematics are drift-exempt bootstrap state; `check` warns (without failing) when an empty schematic coexists with a populated BOM.
- `kicad-tooling`: missing ERC/DRC reports raise kicad-cli's own error instead of an opaque report-read failure.

## Impact

- `src/agent/loop.ts`: turn loop becomes extendable, budget-exhaustion prompt, stash preservation in `fail()`, batching line in the convergence nudge.
- `src/agent/tools.ts`: `resolve_affected` array form, `edit_file` loadability probe, `search`/`run_erc`/`run_drc` message fixes. (Deferral logic in `record_constraint` comes from main.)
- `src/agent/prompts.ts`: batching instruction in WORKFLOW.
- `src/agent/providers/anthropic.ts`: `cache_control` breakpoints.
- `src/util/git.ts`: `preserveFailedRun` helper.
- `src/config.ts`, `src/commands/create.ts`: `stageMaxTurns`.
- `src/cli.ts`: TTY continue-prompt wiring for `do` and `create`.
- Tests: unit tests for all of the above in `test/`; no live-LLM tests required.

Related create completion/export follow-up: [fix-create-stage-evidence](../fix-create-stage-evidence/proposal.md).

# Design: turn-budget-continue-and-loop-efficiency

## Context

Issue #15's trace analysis (`.copperhead/runs/2026-07-21T10-44-49-392Z/`) showed a spec-seed `create` stage that needed ~60 turns to finish cleanly under the current mechanics, against a 40-turn budget. Three compounding causes: the model emitted exactly one tool call per assistant message (nothing in the prompt says batching is possible), 27 of 34 `affects-revisit` obligations targeted a schematic/layout/BOM that did not exist yet, and `finish` was refused with the backlog still open, so the run drained its remaining turns on one-per-turn "no change needed" resolutions. When the budget ran out, `fail()` hard-restored the snapshot and destroyed the work. Separately, the Anthropic provider sends no `cache_control`, so Claude runs pay full input price on the quadratic re-sent conversation.

Current mechanics involved: the turn loop and `fail()` in `src/agent/loop.ts`, the obligations ledger in `src/agent/ledger.ts`, tool handlers in `src/agent/tools.ts`, the WORKFLOW prompt in `src/agent/prompts.ts`, snapshot/restore in `src/util/git.ts`, and the `--interactive` confirm plumbing in `src/cli.ts`.

## Goals / Non-Goals

**Goals:**

- Turn exhaustion in an attended run becomes a user decision with cost visibility, not an unconditional rollback.
- No failure path destroys work: anything touched is recoverable from a stash entry.
- The spec-seed stage (and stages like it) fits comfortably inside the default 40-turn budget through batching guidance, obligation deferral, and array resolution.
- Claude runs get prompt caching without changing the provider interface.

**Non-Goals:**

- No conversation-compaction or context-window management (separate concern).
- No persistence of deferred obligations across runs: cross-run reconciliation stays with `check`/`sync` drift detection and the constraint registry's `affects[]`, which already survives the run.
- No change to the OpenAI provider (prefix caching is automatic there).
- No interactive mid-run steering beyond the continue prompt.

## Decisions

### D1: Continue prompt as an injected callback, not TTY logic in the loop

`RunOptions` gains `onBudgetExhausted?: (stats) => Promise<number>`: it receives `{maxTurns, turnsUsed, tokensIn, tokensOut, filesTouched, openObligations}` (`maxTurns` is the original budget, so the CLI can offer a constant increment across repeat extensions) and returns the number of extra turns (0 means fail as today). A callback that throws (stdin closed mid-prompt) is treated as declining, so the preserve-and-restore path still runs. The CLI wires it to a readline prompt only when stdin and stdout are TTYs; `create` passes the same wiring per stage. The loop stays testable with a fake callback and CI behavior is unchanged by construction (no TTY, no callback firing).

The prompt offers `ceil(maxTurns / 2)` extra turns and shows token usage in thousands (`247.3k in / 9.5k out`). The callback can fire again at the next exhaustion; each extension is a fresh decision with fresh numbers. Alternative considered: a `--continue-turns` flag that pre-authorizes extensions, rejected because the whole point is a human decision at the moment the cost is known.

### D2: Preserve failed work with `git add -A` + `git stash create` + `git stash store`

`git stash create` alone ignores untracked files, and most of what a docs-stage run produces is new files. Staging everything first brings untracked files into the stash object, and `restore()` already does `reset --hard` so the mutated index does not matter. `git stash store -m "copperhead failed run <run-id>"` makes it visible in `git stash list` without touching HEAD or branches. Runs in `fail()` before `restore()` whenever the tree is dirty relative to the snapshot; a no-op on clean trees. Alternative considered: a `copperhead/failed/<run-id>` branch, rejected because it needs a commit identity, pollutes branch listings, and stash entries are the established "recoverable but out of the way" idiom.

### D3: Defer, not skip, revisit obligations for nonexistent artifacts

**Superseded during merge with main.** This PR originally deferred nonexistent-artifact obligations in an in-run ledger list. Before it merged, main landed a stronger deferral (`classifyAffectsTarget` + `affectsTargetExists` persist a `deferred[]` array into `constraints.json`, and `reopenDeferredAffects` re-opens each item at the start of the first run where its artifact exists — cross-run reconciliation, which this PR's design had listed as a non-goal). The reconciliation takes main's persisted mechanism wholesale and drops this PR's in-run version (`ObligationsLedger.defer`, `missingArtifactReason`, and the `## Deferred revisit obligations` summary section). What this PR keeps on top of it: the `resolve_affected` batch form (D5), which clears the obligations main opens, and the budget/continue machinery. Original rationale retained for history: the goal was always to stop dead obligations from draining the turn budget on ceremonial "not yet created" resolutions; main achieves that and more.

### D4: Anthropic prompt caching via three `cache_control` breakpoints

The provider marks `{type: 'ephemeral'}` on: the system prompt (converted to a block array), the last tool definition, and the last content block of the final message. That caches the stable prefix (system + tools) and the growing conversation up to the previous turn. Cache accounting: `usage.input_tokens` excludes cached tokens in the Anthropic API, so `tokensIn` sums `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` to keep the summary's token line honest about volume, while the cost benefit shows up at billing. No provider-interface change.

### D5: `resolve_affected` array form is additive

The schema gains an optional `resolutions: [{constraint_key, item, resolution}]`; the three single-form properties stop being schema-required (JSON Schema cannot express either-or cleanly across providers) and the handler validates: array present wins, else single form, else a corrective error listing both shapes. Each array entry is resolved independently and reported per-item, so one bad key does not waste the whole call.

### D6: Per-stage budgets via `stageMaxTurns` config

`.copperhead/config.json` gains optional `stageMaxTurns: Record<string, number>` keyed by pipeline stage name. `create` passes `stageMaxTurns[stage.name]` as the run's `maxTurns` when present; otherwise the global default applies. Stage names not in the map are unaffected; unknown keys are ignored. Rejected alternative: hardcoded per-stage defaults in `STAGES`, rejected because the right budget depends on the design's size, not just the stage kind.

### D7: Content-aware stage completion with a post-run contract gate

Live runs showed a stage can finish "done" with all gates green having only planned the work (one header edit, ERC "clean" on an empty sheet), after which every later stage runs against a design that is not there. Stage completion is therefore judged by repo state: the schematic stage requires at least one symbol plus drift-clean BOM/PINOUT; layout-draft requires a board containing a footprint plus the LAYOUT.md marker (which `init` scaffolds, so the marker alone proves nothing). `runCreate` re-checks the contract after each successful run and halts with a resume hint rather than advancing. Alternative considered: prompting harder; rejected because a contract that is not enforced is advisory.

### D8: KiCad edits are probe-validated, scoped to what kicad-cli can probe

Anchored text edits can corrupt an s-expression file invisibly; the corruption then surfaces as an opaque ERC failure turns later. After each `edit_file` on a `.kicad_sch`/`.kicad_pcb`, a throwaway kicad-cli export probes loadability: a newly unloadable file is reverted with kicad-cli's own error; a file that was already unloadable keeps the edit (reverting would deadlock incremental repair — every partial fix undone unless one edit fixes the whole file). `.kicad_pro`/`.kicad_sym`/`.kicad_mod` have no standalone load command, so they are exempt from probing: feeding them to a sch/pcb export would reject perfectly good files. Cost: one kicad-cli invocation per sch/pcb edit (~1 s), paid only on the mutation path.

### D9: Zero-symbol schematics are bootstrap state for drift, with a check-side warning

During `create`, docs legitimately lead the schematic (part-selection writes BOM.md before any symbol exists); comparing docs against an empty sheet deadlocked every docs-touching stage and taught the agent to strip BOM.md to appease the gate. `checkDrift` therefore returns clean on zero symbols. Because `check` is the trustworthy CI gate, it separately surfaces a non-failing warning (log line + optional `drift.warning` JSON field, omitted when clean so the stable-key contract holds) when an empty schematic coexists with a populated BOM: bootstrap and an accidentally emptied schematic are indistinguishable mechanically, so a human gets the signal without the gate lying either way.

### D10: Stall detection counts consecutive tool-less turns

The no-tool-call nudge counter was cumulative over the run, so three sporadic empty completions anywhere failed an otherwise-converging run (observed live: three empties across 31 productive turns rolled back a run with 55 turns of budget left). The counter resets whenever the model calls tools again; only three consecutive tool-less turns count as a stall.

## Risks / Trade-offs

- [Deferral heuristic misclassifies an affects item] → It only defers on a positive match against a missing artifact; ambiguous items (refdes, nets, free text) always open real obligations, and every deferral is named in the tool result and summary.
- [Stash entries accumulate across repeated failures] → Each failure logs the exact stash ref and a `git stash drop` hint; entries are cheap and manually reapable.
- [Extended runs can extend repeatedly and burn tokens] → Every extension re-prompts with cumulative token usage; the default answer is No.
- [`cache_control` on very small payloads adds cache-write cost] → Cache writes cost 25% extra once but reads save 90% every following turn; with a 40-turn conversation the break-even is the second turn.
- [Staging everything for the preservation stash includes junk files] → The stash is only created on failure paths and `.gitignore` (which excludes `.env` and `.copperhead/runs/`) is respected by `git add -A`.

## Open Questions

(none: all decisions above are settled for this change)

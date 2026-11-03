# Design: harden-stage-recovery

## Context

See proposal.md for the run that motivates this. The mechanics involved today:

- `runAgentLoop` (`src/agent/loop.ts`) ends a run on one of the exit paths in AC-8.5. The failure path stashes touched work (`preserveFailedRun`, AC-15.16) before `restore()`; the refusal path calls `restore()` directly and stashes nothing. The result carries `outcome`, `exitPath`, `summary`, `stats`.
- `finish` (`src/agent/tools.ts`) takes `outcome` and `summary`; a refusal's reasons exist only as prose.
- `create` (`src/commands/create.ts`) runs each stage in an attempt loop: any non-complete attempt becomes a prose `failure` string, `diagnose()` asks the model for `retry` or `abort`, and a retry reuses `stageTurns`, read once per stage (#135). The supervisor already fact-checks symbol-availability claims deterministically before judging (#197); it has no analogue for constraint claims.
- The constraint registry (`.copperhead/constraints.json`) is readable in-process and is the as-recorded source of every budget the agent cites.
- The `claude-code` provider reads only `usage.input_tokens` from the SDK result; the Anthropic provider sums cache fields (AC-15.15).

## Goals / Non-Goals

**Goals:**

- A stage attempt's ending is a typed cause the pipeline acts on deterministically, with the model supervisor consulted only where judgement is needed.
- A verified design conflict reaches the user as one decision, once, with no turns spent before it.
- A docs-only draft is never re-derived from nothing.
- Telemetry says what it measures.

**Non-Goals:**

- No automatic resolution of a constraint conflict (relaxing a budget on the agent's say-so would undo AC-3.4).
- No change to rollback for stages that touch KiCad files (#208).
- No change to the CLI tool protocol or to how many calls a turn carries (#192).
- No interactive prompt at the decision stop in this change; the stop is printed and written, and resume is the re-run. A TTY prompt can be layered on later without changing these specs.

## Decisions

### D1: Blockers are structured in `finish`, and verified against the registry, not parsed from prose

`finish` gains `blockers?: Array<{kind: 'constraint-conflict', constraint: string, required: string, found: string}>`. The handler checks each `constraint` against the loaded registry; verified ones go on `ctx.finishRequest.blockers`, the rest are appended to the summary as "(unverified claim)". Alternatives: regex-mining constraint keys from the refusal summary (brittle, and a hallucinated key would look identical), or letting the supervisor adjudicate (a model judging a model's claim is what #197 moved away from). Verification is the same shape as `symbolAvailabilityFacts`: a deterministic probe decides, the narration does not. The refusal path in the loop copies the verified blockers onto the run result and the `run-refused` event.

### D2: Classification is a pure function of the run result

`classifyAttempt(res): 'constraint-conflict' | 'turn-budget-exhausted' | 'other'` lives beside the attempt loop and reads only `res.outcome`, `res.exitPath` and `res.blockers`. A stage that completed never reaches it. Keeping it pure makes the policy table testable without a provider: conflict stops, exhaustion escalates and still asks the supervisor for guidance, other asks the supervisor as today.

### D3: Escalation is deterministic, bounded, and per stage

`nextBudget(prev, start) = min(ceil(prev * 1.5), start * 3)`, applied only when the cause is `turn-budget-exhausted`. The supervisor is still called for guidance (it often knows why the turns went), but its verdict cannot lower or raise the budget. Alternatives: letting the supervisor return a turn count (unbounded, and a number the model cannot ground), or a flat increment (40 → 60 → 80 is too slow for the 100-turn stage in #446). The cap of 3× keeps a runaway stage under the per-run cost a user set with `maxTurns` and `stageMaxTurns`; `maxStageRetries` still bounds attempts.

### D4: The decision stop is a rendered block, written twice

`renderDecisionStop(stage, attempt, blockers)` produces the terminal text and the markdown appended to the attempt's `summary.md`. It names, per blocker: key, required, found, attempt; then the two routes (revise the constraint where it is recorded, naming the doc that `record_constraint` cited as its source, or name a compliant part in the brief or SUBSYSTEMS.md); then "re-running `copperhead create` resumes at <stage>". It holds no absolute path and no stack trace, matching AC-15.33's style. `create` exits non-zero through the existing "stopped for a human" path, so `runCreate` returns a `stop` field naming the stage, the cause and the verified blockers.

### D5: Draft continuity reuses the failed-run stash

The refusal path calls `preserveFailedRun` before `restore()`, so refused and failed runs leave the same `copperhead failed run <run-id>` entry. `create` keeps the last attempt's run id; for a docs-only stage (`DOCS_ONLY_STAGES = ['spec-seed', 'architecture', 'part-selection']`), before the retry it calls `applyFailedRun(repo, runId)` (new, in `src/util/git.ts`: `git stash apply` of the entry found by message, then the entry is dropped on success and kept on conflict). The restored files are passed to the retry as `preTouched`, so they open the same drift (and ERC) obligations an edit would and `finish` cannot pass over them unchecked. The retry's own pre-run snapshot is taken after the apply, so the loop's rollback contract is unchanged: a second failure restores to "pre-stage tree + first draft", stashes the second draft, and the third attempt applies that. When the stage stops after an apply with no attempt committed, the tree goes back to the stage's own pre-stage snapshot, so a later `create` cannot mistake the draft for already-complete work; the draft stays in the last attempt's stash entry. Guidance gets a line listing the files the stash touched. Alternatives: skipping rollback entirely for docs-only stages (breaks AC-3.6/AC-15.16's byte-identical restore, which tests and users rely on), or committing drafts (that is #208's territory and changes what a stage commit certifies).

### D6: Provider usage follows the Anthropic provider's rule

`inputTokens = input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)` from the SDK's `result` message. Nothing else in the provider changes. The cost table's `cache` column is renamed `replayed` with the total line reading `N% turns replayed`; the JSON key `cacheHitPct` is kept for compatibility and documented as replayed-turn percentage.

### D7: Attempt boundaries log through the stage line, every attempt

The attempt loop already logs `running (attempt n/m)`; this change adds a stage line naming the cause and the action (`stop: constraint conflict`, `retry with 60 turns`, `retry (supervisor: …)`), so a user watching create.log sees every attempt even when the transcripts hold the detail.

## Risks / Trade-offs

- [The model omits `blockers` and refuses in prose] → The cause is `other` and the supervisor path runs as today; the stage prompt for part selection tells the agent to use `blockers` for any constraint it cannot satisfy, and the summary still carries the prose.
- [A stash that does not apply cleanly on retry] → The entry is kept, the conflict is logged, the retry starts from the pre-stage tree with guidance saying the draft could not be restored; nothing is lost.
- [Escalation triples the cost of a stage that would never finish] → The supervisor's `abort` still stops it, `maxStageRetries` bounds attempts, and the cap is relative to a budget the user set.
- [A registered but wrongly recorded constraint stops a run it should not] → The decision block names the constraint's source doc so the fix is one edit; this is the correct failure mode for a requirement the user wrote.

## Migration Plan

No data migration. Existing `stageMaxTurns` entries become the starting budget for escalation. Runs recorded before this change have no `blockers` field; readers treat it as empty. Rollback is reverting the change; stash entries it created are ordinary stash entries.

## Open Questions

- Whether the decision stop should also be offered as an inline choice in `--interactive` runs (relax, with a DECISIONS.md entry, or stop). Deferred; it does not change these specs or tasks.

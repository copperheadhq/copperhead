# Design: escalate-near-budget-refusal

## Context

`classifyAttempt` (`src/commands/stage-recovery.ts`, design D2 of harden-stage-recovery) is a pure function of `outcome`, `exitPath` and `blockers`. The loop ends a run on `refused` when the agent calls `finish` with outcome `refuse`; the turn budget is only an exit path when the loop itself runs out (`turn-budget-exhausted`). An agent that sees the end coming refuses a few turns early, and that refusal is indistinguishable from a design refusal by exit path alone. `RunStats` carries `turnsUsed`, `maxTurns` and `budget` (the budget the run ended with, after any attended extension).

## Goals / Non-Goals

**Goals:**

- A refusal whose real cause is the budget escalates like an exhaustion, deterministically, with no model asked to say so.
- The log says when this rule fired and on what numbers.

**Non-Goals:**

- No parsing of the refusal prose for words like "turns". A hallucinated reason would read the same, and the numbers are already on the result.
- No change to how a verified blocker is handled, and no change to the escalation arithmetic.

## Decisions

### D1: The rule is numeric, on the run's own stats

A refused result with no verified blocker is `turn-budget-exhausted` when `turnsUsed >= ceil(NEAR_BUDGET_FRACTION * budget)`, with `budget = stats.budget ?? stats.maxTurns` and `NEAR_BUDGET_FRACTION = 0.8`. At 40 turns the rule fires from turn 32, which covers the turn-37 refusal in #446; at 120 it fires from turn 96. Alternatives: a fixed number of turns from the end (5 turns is a quarter of a 20-turn budget and nothing of a 120-turn one), or looking for budget words in the summary (D2 of the parent change rejected narration as a classifier). The fraction is a constant, not config: it is a classification threshold, not a budget the user sets.

### D2: Misclassification is bounded in both directions

A design refusal at turn 96 of 120 that names no registered constraint is escalated and retried at up to 3x the starting budget; the supervisor is still consulted and its `abort` still stops the stage, and `maxStageRetries` still bounds attempts, so the cost of a wrong guess is one supervised retry. A budget refusal at turn 30 of 40 stays `other` and goes to the supervisor with the same budget, which is today's behaviour. Precedence is unchanged: a verified blocker is `constraint-conflict` whatever the turn count.

### D3: The reason rides on the cause line

`classifyAttempt` stays a pure function returning the cause; a companion `causeNote(res, cause)` returns `refused at turn 37 of 40` when the rule fired and an empty string otherwise. `create` appends it in parentheses to the `attempt n ended:` stage line and to the `cause:` entry in `summary.md`, so AC-18.6's three-line shape holds and a reader sees why a refusal escalated.

## Risks / Trade-offs

- [A model refuses early on purpose to get more turns] → It cannot see the classifier; the supervisor still reads the transcript and can abort.
- [A stage with a tiny budget] → At 5 turns the rule fires from turn 4; with `ceil` it never fires on turn 0 of any budget.

## Migration Plan

None. Old runs are not reclassified.

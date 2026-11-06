## 1. Classification

- [x] 1.1 Add `NEAR_BUDGET_FRACTION` and extend `classifyAttempt` to read `stats`: a refused result with no verified blocker and `turnsUsed >= ceil(0.8 * (stats.budget ?? stats.maxTurns))` is `turn-budget-exhausted`. Unit-test the table: 37/40 refused is exhausted, 31/40 is other, 32/40 is exhausted, a verified blocker at 37/40 is still constraint-conflict, an extended budget (maxTurns 40, budget 60) at 37 is other, no stats is other (AC-18.16, AC-18.8).
- [x] 1.2 Add `causeNote(res, cause)` returning `refused at turn N of B` when the rule fired, else an empty string; unit-test both.

## 2. Pipeline

- [x] 2.1 Append the note to the `attempt n ended:` stage line and the `cause:` summary entry in `create`. Pipeline test with a scripted stage: a part-selection refusal at 37 of 40 with no blocker logs `attempt 1 ended: turn-budget-exhausted (refused at turn 37 of 40)`, consults the supervisor once, and retries with 60 turns (AC-18.16).

## 3. Spec

- [x] 3.1 Update SPEC.md §4.5's classification bullet, narrow AC-18.8 to a refusal with turns to spare, add AC-18.16; `openspec validate escalate-near-budget-refusal` passes.

## 4. Check

- [x] 4.1 `npm run build`, `npm run typecheck` (if present) and `npm test` green.

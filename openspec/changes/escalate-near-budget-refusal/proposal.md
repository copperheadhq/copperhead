# Proposal: escalate-near-budget-refusal

## Why

Issue #446, attempt 2: part selection refused at turn 37 of 40 with "I can't finish a valid BOM in the turns left". The run ended as a refusal, so harden-stage-recovery (#461) classifies it as `other`: the supervisor is consulted and a retry keeps the same 40 turns. The attempt was spent on its budget in every way that matters, and the budget is what a retry needs more of. The escalation rule already exists for `turn-budget-exhausted`; this change makes a budget-shaped refusal reach it.

## What Changes

- **Near-budget refusal classifies as exhaustion.** A refused attempt with no verified blocker whose turns used are at least 80% of its budget is cause `turn-budget-exhausted`, so the retry escalates (1.5x, capped at 3x) and the supervisor is still consulted for guidance. A refusal with turns to spare stays `other`; a refusal with a verified blocker stays `constraint-conflict`.
- **The cause line says why.** When a refusal is classified as exhaustion, the attempt's cause line and its `summary.md` note say so: `turn-budget-exhausted (refused at turn 37 of 40)`.

Out of scope: a provider-side signal for "out of turns" (the agent has no view of the budget beyond the prompt), persisting verified part lookups across attempts (#459), and any change to the constraint-conflict stop.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `create-pipeline`: stage attempt cause classification treats a blocker-free refusal within the last fifth of its budget as `turn-budget-exhausted`.

## Impact

- `src/commands/stage-recovery.ts` (`classifyAttempt` reads `stats`; a note for the cause line), `src/commands/create.ts` (cause line and summary note carry the reason).
- SPEC.md §4.5 bullet on classification; AC-18.8 narrowed to a refusal with turns to spare; new AC-18.16.
- Tests: `test/stage-recovery.test.ts` unit cases for the threshold and a pipeline case for the escalated retry.

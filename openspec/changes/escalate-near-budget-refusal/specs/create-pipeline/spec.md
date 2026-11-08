# create-pipeline delta spec

## MODIFIED Requirements

### Requirement: Stage attempt cause classification

After every stage attempt that does not complete the stage, `create` SHALL classify the cause before deciding what to do next: `constraint-conflict` when the attempt refused with at least one verified constraint-conflict blocker; `turn-budget-exhausted` when the run ended on the turn budget, or when it refused with no verified blocker after using at least 80% of its budget (the budget the run ended with, rounded up); otherwise `other`. The classification and the action taken SHALL be logged as a stage line and recorded in the attempt's run summary; when a refusal is classified as `turn-budget-exhausted`, both SHALL say so with the turns used and the budget.

#### Scenario: Cause is logged for every attempt (AC-18.6)

- **WHEN** part selection's second attempt ends on the turn budget
- **THEN** the create log holds a stage line for the attempt's start (`running (attempt 2/3)`), one naming the cause `turn-budget-exhausted`, and one naming the action taken, in that order

#### Scenario: A refusal near the end of the budget escalates (AC-18.16)

- **WHEN** part selection's first attempt refuses with no verified blocker at turn 37 of 40, and the supervisor says retry
- **THEN** the cause line reads `turn-budget-exhausted (refused at turn 37 of 40)`, the second attempt runs with 60 turns, and the attempt's `summary.md` records the same cause

#### Scenario: A refusal with turns to spare stays other (AC-18.8)

- **WHEN** an attempt refuses at turn 3 of 40 citing a constraint that is not registered
- **THEN** the cause is `other`, the recovery supervisor is consulted as before, its verdict decides the retry, and the retry keeps the budget

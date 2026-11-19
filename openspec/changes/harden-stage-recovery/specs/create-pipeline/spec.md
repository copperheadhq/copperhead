# create-pipeline delta spec

## ADDED Requirements

### Requirement: Stage attempt cause classification

After every stage attempt that does not complete the stage, `create` SHALL classify the cause before deciding what to do next: `constraint-conflict` when the attempt refused with at least one verified constraint-conflict blocker; `turn-budget-exhausted` when the run ended on the turn budget; otherwise `other`. The classification and the action taken SHALL be logged as a stage line and recorded in the attempt's run summary.

#### Scenario: Cause is logged for every attempt (AC-18.6)

- **WHEN** part selection's second attempt ends on the turn budget
- **THEN** the create log holds a stage line for the attempt's start (`running (attempt 2/3)`), one naming the cause `turn-budget-exhausted`, and one naming the action taken, in that order

### Requirement: Verified constraint conflict stops the stage

When an attempt's cause is `constraint-conflict`, `create` SHALL NOT call the recovery supervisor and SHALL NOT retry. It SHALL print a decision block that names, for each verified blocker, the constraint key, its required value, the failing candidate, the attempt that found it and the document the constraint was recorded from; states the two ways forward (revise the constraint and the document it comes from, or name a compliant part in the brief or `docs/SUBSYSTEMS.md`); and says that re-running `create` resumes at this stage. The block SHALL be appended to the attempt's `summary.md`. The pipeline SHALL exit non-zero with the completed stages still committed.

#### Scenario: Conflict stops without retry (AC-18.7)

- **WHEN** part selection's first attempt refuses with a verified blocker on `protection.precharge_bypass` and `maxStageRetries` is 2
- **THEN** no second attempt starts, no diagnosis call is made, the terminal shows the decision block naming the key, `≥ 16 A`, the failing relay and attempt 1, and `create` exits non-zero with spec-seed and architecture still committed

#### Scenario: Unverified claim still goes to the supervisor (AC-18.8)

- **WHEN** an attempt refuses citing a constraint that is not registered
- **THEN** the cause is `other`, the recovery supervisor is consulted as before, and its verdict decides the retry

### Requirement: Budget exhaustion retries with more turns

When an attempt's cause is `turn-budget-exhausted` and retries remain, `create` SHALL retry with a turn budget of 1.5 times the previous attempt's budget, rounded up, never above 3 times the stage's starting budget (the stage's `stageMaxTurns` entry, else `maxTurns`). The supervisor SHALL still be consulted for guidance, and an `abort` verdict SHALL still stop the stage. The escalated budget SHALL be logged in the attempt's stage line.

#### Scenario: Escalation arithmetic (AC-18.9)

- **WHEN** a stage with a starting budget of 40 exhausts attempt 1, then attempt 2, then attempt 3 with `maxStageRetries` of 3
- **THEN** attempt 2 runs with 60 turns, attempt 3 with 90, and attempt 4 with 120

#### Scenario: Other causes keep the budget (AC-18.10)

- **WHEN** an attempt ends as `provider-error` and the supervisor says retry
- **THEN** the next attempt runs with the same budget as the previous one

### Requirement: Docs-only stages resume from the preserved draft

For the spec-seed, architecture and part-selection stages, before each retry `create` SHALL apply the previous attempt's `copperhead failed run <run-id>` stash entry (when one exists) to the working tree, so the retry starts from the draft the previous attempt wrote, and SHALL say so in the recovery guidance by naming the restored files, and SHALL count the restored files as touched by the retry so its sync and verification obligations cover them. When a docs-only stage stops after a retry restored a draft, and no attempt committed, `create` SHALL put the tree back to its pre-stage state and leave the draft in the last attempt's stash entry. A stash that does not apply cleanly SHALL be left in place, reported, and the retry SHALL start from the pre-stage tree. Stages that touch KiCad files SHALL keep the existing rollback behaviour.

#### Scenario: Retry continues the draft (AC-18.11)

- **WHEN** part selection's first attempt writes `docs/BOM.md` and ends on the turn budget, and the supervisor says retry
- **THEN** the second attempt's first `read_file docs/BOM.md` returns the first attempt's draft, and the recovery guidance names `docs/BOM.md` as restored from the previous attempt

#### Scenario: Restored files are the retry's own edits (AC-18.14)

- **WHEN** a part-selection retry runs after an earlier attempt's `docs/BOM.md` and `.copperhead/constraints.json` were restored, whether this retry's apply changed their bytes or an earlier one did
- **THEN** the retry runs with those files counted as touched, the revisit obligations of each constraint the registry holds beyond HEAD are reopened, and `finish` with outcome `done` is refused until they are resolved and `check_drift` has run clean

#### Scenario: A stop after a restored draft leaves the pre-stage tree (AC-18.15)

- **WHEN** part selection's second attempt, started from the first attempt's restored `docs/BOM.md`, ends without completing the stage and the stage stops
- **THEN** the tree is back at its pre-stage state, the draft is in the last attempt's `copperhead failed run <run-id>` stash entry, and a re-run of `create` runs part selection again instead of committing the draft as already complete

#### Scenario: KiCad stages are unchanged (AC-18.12)

- **WHEN** the schematic stage's attempt fails
- **THEN** the retry starts from the pre-stage tree exactly as before, with the failed work only in the stash entry

### Requirement: Cost table names the response cache

The create cost table and its JSON form SHALL label the cache column as turns replayed from copperhead's response cache (`Replayed`), never as provider cache hits, and the human-readable total line SHALL read `N% turns replayed`.

#### Scenario: Fresh run shows zero replayed (AC-18.13)

- **WHEN** a create run makes every model call live
- **THEN** the cost table's column header is `Replayed` and the total line says `0% turns replayed`

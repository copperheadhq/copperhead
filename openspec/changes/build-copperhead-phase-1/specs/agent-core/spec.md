# agent-core — Delta Spec

## ADDED Requirements

### Requirement: Provider-agnostic tool-use loop
The agent core SHALL implement a tool-use loop behind a `Provider` interface (`chat(messages, tools, opts) → Turn`) with OpenAI and Anthropic implementations, and both providers MUST pass the same integration test on the fixture repo.

#### Scenario: Provider parity (AC-3.10)
- **WHEN** the net-rename integration test (AC-3.1) runs with `--model gpt-5` and again with `--model claude`
- **THEN** both runs pass with the same observable outcome

#### Scenario: Rate-limit failover
- **WHEN** a provider returns 429 three times despite exponential backoff
- **THEN** the loop fails over to the other provider if its API key exists, otherwise fails the run

#### Scenario: Cancelled provider turn
- **WHEN** the watchdog abandons an API request or saved-login turn
- **THEN** its request is cancelled and any late completion cannot replace a newer session's state; retries are owned by the shared wrapper, with SDK retries disabled

#### Scenario: Transient provider error
- **WHEN** a provider request fails with HTTP 408/409/5xx or an SDK connection error
- **THEN** the shared policy retries within the same bounded backoff budget; aborts, watchdog errors and parse failures are not retried by that policy, and failover remains limited to rate limits

#### Scenario: Nested skill history
- **WHEN** a sessionful provider switches from the parent conversation to a nested skill or back again
- **THEN** it starts a fresh session with that conversation's full context instead of reusing an unrelated message cursor

#### Scenario: Failed SDK turn
- **WHEN** the SDK reports that its turn failed after emitting partial content
- **THEN** partial tool requests from that turn do not execute

#### Scenario: Changed cached tool contract
- **WHEN** a tool's schema or description changes while its name stays the same
- **THEN** the provider is called again instead of replaying a turn generated for the old contract

#### Scenario: Cached turns in a resumed Codex conversation
- **WHEN** cached assistant turns are replayed between two live Codex calls
- **THEN** the next live call receives those unseen assistant turns before their tool results, while omitting only the previous response already generated in that Codex thread

#### Scenario: Secret-bearing response bypasses caching
- **WHEN** a response contains a recognized secret pattern or a configured secret environment value
- **THEN** the live turn is returned unchanged but is not persisted; a matching unsafe cached entry is discarded instead of replayed

### Requirement: Loop sequence
Each `do` run SHALL follow the sequence: load memory (all `docs/*.md` + schematic file list into context) → plan → edit → verify (ERC always; DRC if the board changed) → repair → propagate (`check_drift`) → rationale → commit.

#### Scenario: Docs loaded before planning
- **WHEN** a `do` run starts
- **THEN** the transcript shows every `docs/*.md` file included in the system context before the first plan or edit

#### Scenario: Propagating rename (AC-3.1)
- **WHEN** `do "rename net KEY_DAH to KEY_DASH"` completes
- **THEN** the net is renamed in every sheet, PINOUT.md and SUBSYSTEMS.md are updated, ERC exits 0, exactly one commit exists, and no unrelated net or doc line changed

### Requirement: Turn and repair budgets
The loop SHALL enforce `maxTurns` (default 40) and `maxRepairCycles` (default 5), log per-run token usage, and on unrecoverable failure restore the pre-run snapshot, print the transcript path, and exit 1.

#### Scenario: Repair loop converges (AC-3.5)
- **WHEN** an edit first produces an ERC violation
- **THEN** the transcript shows the violation parsed, a targeted fix, a re-run, and a pass within `maxRepairCycles`

#### Scenario: Rollback on exhaustion (AC-3.6)
- **WHEN** violations persist after `maxRepairCycles`
- **THEN** the working tree is byte-identical to the pre-run state, the exit code is non-zero, and the transcript path is printed

### Requirement: Constraint-holding system prompt
The system prompt SHALL include the verbatim rules of SPEC.md §4.3, the `budgets` from config, and the constraint registry, requiring the agent to hold all constraints simultaneously, consult strapping tables before pin assignment, and record a one-line rationale for every decision.

#### Scenario: Constraint-aware pin move (AC-3.2)
- **WHEN** `do "move the key input to a different RTC-capable pin"` runs against the ESP32-S3 fixture
- **THEN** the chosen pin is RTC-capable and not a strapping pin (GPIO0/3/45/46), the transcript shows the strapping table was consulted, schematic and PINOUT.md agree, and ERC exits 0

#### Scenario: Budget refusal (AC-3.4)
- **WHEN** `do "add a 100kΩ pullup on KEY_DAH"` would leak ~33 µA against a documented 25 µA sleep budget
- **THEN** the agent refuses or proposes an alternative, citing the budget from SPEC.md, and does not silently comply

### Requirement: Sync obligations block commit
The loop SHALL maintain an obligations ledger fed by deterministic post-tool-call hooks: editing a KiCad file records ERC/DRC, drift-check, and changelog obligations; recording a constraint records dual-write verification and a revisit obligation for every item in its `affects[]` whose target artifact exists — an item targeting a not-yet-built artifact (schematic, board, BOM before their pipeline stage) is marked `deferred` in the registry instead and re-opens at the start of the first run where the artifact exists; a non-trivial decision records a `docs/DECISIONS.md` append obligation. The commit step SHALL refuse to run while any obligation is open, and the ledger's final state SHALL be written into the run's `summary.md`.

#### Scenario: Stale doc blocks commit
- **WHEN** a run edits a schematic value referenced by BOM.md but has not yet updated the doc
- **THEN** the commit step refuses, naming the open drift obligation, until the doc is updated and `check_drift` runs clean

#### Scenario: Accepted finish ends tool execution
- **WHEN** a model response contains an accepted `finish` followed by more tool calls
- **THEN** later calls execute nothing and cannot mutate the verified design or override a refusal

#### Scenario: Changelog write failure
- **WHEN** the required changelog cannot be written
- **THEN** the run preserves failed work, restores its snapshot, and reports commit failure without committing; successful commits require the full ledger to be clear

#### Scenario: Constraint change forces affects revisit
- **WHEN** a constraint with `affects: ["U2", "R7-absent"]` is modified during a run
- **THEN** the run cannot commit until each affected item is explicitly resolved as changed or "no change needed" with a reason

#### Scenario: Deferred revisit for unbuilt artifacts
- **WHEN** a docs-only stage records a constraint with `affects: ["layout", "R1"]` before any board exists
- **THEN** only the R1 revisit obligation opens now; the layout item is marked deferred and its obligation re-opens automatically at the start of the first run where a board is configured

#### Scenario: Aborted run shows open obligations
- **WHEN** a run fails or is aborted with obligations open
- **THEN** `summary.md` lists exactly which sync obligations were unmet

### Requirement: Surgical s-expression edits
Edits to `.kicad_sch`/`.kicad_pcb` SHALL be anchored text replacements on the s-expression source; full-file regeneration is forbidden.

#### Scenario: Diff locality (AC-3.7)
- **WHEN** the AC-3.1 rename run completes
- **THEN** the `.kicad_sch` diff touches under 5% of the file's lines and only s-expressions relevant to the change

#### Scenario: Add part with library discipline (AC-3.3)
- **WHEN** `do "add a second RGB LED"` completes
- **THEN** a new symbol exists with a unique refdes, a valid footprint from the existing library set, and a net connected to a real GPIO, and BOM.md gains a row flagged `UNVERIFIED` with a one-line rationale, with ERC exiting 0

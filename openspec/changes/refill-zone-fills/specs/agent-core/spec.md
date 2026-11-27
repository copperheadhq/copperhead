# agent-core delta spec

## ADDED Requirements

### Requirement: `run_drc` fills the pours of a board the run edited

When edits are unlocked and the configured board is already among the run's touched files, `run_drc` SHALL refresh the board's zone fills, write the result to the board when it differs, and then run DRC on the board in place. The write SHALL NOT reopen a sync obligation (drift, changelog, ERC) the run had already closed, since it changes only fill data on a board the run already edited; it SHALL invalidate the last DRC result. It SHALL NOT refill again a board whose text and rule files are unchanged since its last refresh in the run. In every other case (edits locked, board not touched, or refill unavailable) `run_drc` SHALL NOT write the board; when its DRC fails there and the refreshed copy's DRC has fewer findings (violations and library-intrinsic findings counted together on both sides, library checks aside), the result SHALL say that the pour fills are stale, how many findings they cause and, when edits are unlocked, that `fill_zones` refreshes them; a failing board whose fills are current SHALL get no such note, and a board unchanged since that check SHALL NOT be refilled again to repeat it. Inside a skill whose tools include no mutation tool, `run_drc` SHALL NOT write the board, even one the run edited. When the refresh fails, `run_drc` SHALL leave the board unwritten, report the refresh failure beside a plain DRC result, and the run's rollback rules apply unchanged.

#### Scenario: A move into a pour no longer fails on a stale fill (AC-22.8)

- **WHEN** an unlocked run moves a footprint into a filled GND pour with `move_footprint` and calls `run_drc`
- **THEN** the board is written with refreshed fills, DRC passes with no short or clearance violation from the old fill, and the board's version header is unchanged

#### Scenario: A pour the agent adds is filled (AC-22.9)

- **WHEN** an unlocked run adds a GND zone with `edit_file` and calls `run_drc`
- **THEN** the zone holds fill data in the written board, and the pads it covers no longer count as unrouted

#### Scenario: Read-only outside an edited board (AC-22.10)

- **WHEN** `run_drc` runs before edits unlock, or on a board the run has not touched, and the board's fills are stale
- **THEN** the board's bytes are unchanged, and the result names the stale fills
- **WHEN** `generate_report` calls `run_drc` on a board the run edited, with edits unlocked
- **THEN** the board's bytes are unchanged, and the result names the stale fills

#### Scenario: A refill reopens no closed obligation (AC-22.11)

- **WHEN** a run edits the board, closes its drift and changelog obligations, and then calls `run_drc`, which refills
- **THEN** no obligation is reopened, and `finish` succeeds once that DRC passes

#### Scenario: A failed run restores the board's fills (AC-22.12)

- **WHEN** a run whose `run_drc` refilled the board ends in failure
- **THEN** the board is byte-identical to the board the run started with, fills included

### Requirement: `fill_zones` tool

The system SHALL provide a spec-gated `fill_zones` tool, absent until edits unlock, that refreshes the configured board's zone fills and writes the board when they change, recording the board as touched like any board edit (so DRC must pass before `finish`). When nothing changes it SHALL say so and write nothing. When zone refill is unavailable it SHALL fail and say why.

#### Scenario: Refill on request (AC-22.13)

- **WHEN** an unlocked run that has not touched the board calls `fill_zones` on a board with stale fills
- **THEN** the board is written with refreshed fills, the board is among the touched files, and `finish` refuses until `run_drc` passes

### Requirement: The unrouted baseline counts filled pours

The starting unrouted count that `run_drc` compares against (AC-15.39) SHALL be taken from KiCad's DRC of the starting board after its zone fills are refreshed beside the project's rule files, so a fill that was stale or missing when the run began cannot make the run look like it broke a connection. When refill is unavailable, the count SHALL be taken as before. When the refill of the edited board fails in a `run_drc`, that DRC counts the board's stored fills, and it SHALL be compared with the starting board's stored fills instead.

#### Scenario: A stale fill at the start is not blamed on the run (AC-22.14)

- **WHEN** a run starts from a board whose stored GND fill bridges a pad that a fresh fill isolates, and the run edits elsewhere and calls `run_drc`
- **THEN** `run_drc` reports no `unrouted_increase`
- **WHEN** a run starts from a board whose GND pours were never filled, adds a zone KiCad drops when it loads the board, and calls `run_drc`
- **THEN** the result says the fills were not refreshed, and reports no `unrouted_increase`

### Requirement: Fab export refuses missing or out-of-date fills

`export_outputs` SHALL refuse, writing no outputs, when a copper zone on the board has no fill data or when the stored fills differ from a refresh by the running kicad-cli, and SHALL name the zones and say that `fill_zones` (or `run_drc` after a board edit) refreshes them. Without refill support it SHALL still refuse a zone with no fill data, including one the run drew already marked filled; a zone KiCad filled to nothing, held as the run found it, SHALL NOT count. Once the fills are current it SHALL export as before.

#### Scenario: Gerbers never ship without the pour (AC-22.15)

- **WHEN** an unlocked run calls `export_outputs` on a board with an unfilled GND zone
- **THEN** no file is written under `outputs/`, and the result names the zone and `fill_zones`
- **WHEN** kicad-cli cannot refill, and the run drew a GND zone already marked `(fill yes` with no fill data
- **THEN** `export_outputs` refuses it the same way

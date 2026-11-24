# Proposal: refill-zone-fills

## Why

Issue #469: on a board that is mostly a filled GND pour, `copperhead do` refuses almost every placement or routing change. A `.kicad_pcb` stores each zone's fill as `filled_polygon` blocks computed against the copper as it was when someone last filled zones in KiCad, and every copperhead DRC runs `kicad-cli pcb drc` without `--refill-zones`. When a pad or track moves into a pour, the stale fill overlaps it and DRC reports shorts that only a refill clears; no tool can refill, and the model rightly will not hand-write polygon data, so it refuses. The reporter worked around it three times in one day with a pcbnew script and a manual `kicad-cli` refill, outside the spec gate, verification and rollback.

The same gap has a quieter half: copperhead never fills a zone for the first time either. A pour the agent writes with `edit_file` (the layout-draft stage invites it) is committed as an outline with no copper. DRC passes, because there is nothing to clash with; the pads it should join are counted as unrouted; and `export_outputs` writes gerbers without the pour.

PR #478 tried `--refill-zones --save-board` on the real board. That lets KiCad rewrite the whole file in its own format (a KiCad 8 board comes back as a KiCad 10 file older KiCad cannot open, and the diff is the whole file), and it runs on every DRC, including read-only runs.

## What Changes

- **A reusable zone filler** (`src/kicad/zones.ts`). It refills a scratch copy of the board, placed beside copies of the project's `.kicad_pro` and `.kicad_dru` so net-class clearances and custom rules apply, with `kicad-cli pcb drc --refill-zones --save-board`. It then splices only each zone's fill blocks back into the original text, matched by the zone's uuid (or tstamp), and marks the zone filled. Every other byte of the board, its format version included, stays as it was. KiCad must read the spliced board back with exactly the fills it computed (loaded and saved with `kicad-cli pcb upgrade --force`, which does not refill), or the filler refuses, naming the zone. It returns text and never writes the design file itself.
- **`run_drc` fills the pours of a board the run edited.** When edits are unlocked and the board is already among the run's touched files, `run_drc` refills before it checks, writes the board, and runs DRC on the result. Otherwise it stays read-only and, when DRC fails and a refilled copy would pass, says the fills are stale. The refill is derived data, so it reopens no ledger obligation the agent already closed.
- **A spec-gated `fill_zones` tool** for an explicit request to fill or refill pours on a board the run has not otherwise touched.
- **Unrouted counts read filled pours.** The run's starting unrouted count (AC-15.39) is taken on a refilled copy beside the project files, so a stale or missing fill at the start cannot make a run look like it broke a connection.
- **`check` reports stale or missing fills, read-only.** When DRC fails, or a copper zone has no fill, `check` compares against a refilled scratch copy and adds a finding naming the zones. It never writes the board.
- **`export_outputs` refuses on missing or stale fills**, so gerbers cannot ship without the copper the board file implies.
- **Older kicad-cli.** The filler detects `--refill-zones` and `--save-board` from `pcb drc --help`. Without them (KiCad 8), `run_drc` and `check` keep today's plain DRC and say fills were not refreshed, and `fill_zones` reports that it is unavailable.
- **Prompt guidance.** The `do` rules and the layout-draft stage say that `run_drc` fills pours on a board the run changed, and that fill blocks are never written by hand.

Out of scope: having `create` add a GND pour by default; the fab release gate (`add-fab-release-gate`), which can reuse the filler for its own freshness check; and refill for boards KiCad cannot load.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `kicad-tooling`: a zone-fill refresh that computes fills on a scratch copy with the project's rules and splices only fill data into the board text.
- `agent-core`: `run_drc` refills pours on a board the run edited; a `fill_zones` tool; the unrouted baseline is counted on filled pours; `export_outputs` refuses on missing or stale fills.
- `cli-surface`: `check` reports stale or missing pour fills and stays read-only.

## Impact

- New `src/kicad/zones.ts`; `src/kicad/cli.ts` (refill capability probe, a refill-and-save runner for scratch copies, `unroutedCount` on a filled copy).
- `src/capabilities/handlers.ts` (`run_drc`, new `fill_zones`, `unroutedGuard`, `export_outputs`), `src/capabilities/index.ts` (hint for `fill_zones`), `src/commands/check.ts`, `src/agent/prompts.ts`, the layout-draft stage text in `src/commands/create.ts`.
- SPEC.md §4.2 (`run_drc` row, new `fill_zones` row), §First-draft layout, AC-15.39, new AC-22.
- Tests: a KiCad 8-format board with GND pours on both layers and a `.kicad_pro` with a non-default clearance, in unfilled, fresh and stale variants; splice unit tests that need no kicad-cli.
- Runtime: a board edit followed by `run_drc` costs two more kicad-cli runs: the refill, which is a DRC, and a load-and-save that checks the splice. A board with no copper zones costs nothing extra.

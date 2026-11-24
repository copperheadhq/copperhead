# Design: refill-zone-fills

## Context

See proposal.md for the problem. The relevant facts about KiCad, each checked against kicad-cli 10.0.6:

- A zone's fill is `filled_polygon` blocks (or legacy `fill_segments`) inside its `(zone …)` list, plus a `yes` flag in its `(fill …)` child. Nothing else in the file depends on them.
- `kicad-cli pcb drc --refill-zones --save-board <board>` refills and saves, but saves the whole board in the running KiCad's format: a `(version 20240108)` board comes back as `(version 20260206)` with KiCad 10's layout (one child per line, nets named inline, no `filled_areas_thickness`), and a `.kicad_prl` appears beside it.
- Refilling a freshly filled board with the same kicad-cli is byte-identical, so a refresh is stable.
- `kicad-cli pcb upgrade --force <board>` loads a board and saves it in the current format without refilling zones, so the saved copy holds exactly the fills KiCad read from the file.
- Fills depend on the project file. The same board refilled without its `.kicad_pro` (default 0.2 mm clearance) and checked beside one that sets 1.0 mm gave 8 clearance violations.
- A pre-KiCad 10 zone without `(filled_areas_thickness no)` is read as a legacy fill and inflated by half its minimum thickness: 0.3755 mm where 0.5 mm was required. Every zone KiCad 6 to 9 writes carries the token, so only a hand-written zone lacks it. KiCad 10 no longer writes it.
- The pcbnew Python API crashes in `ZONE_FILLER.Fill` and `SaveBoard` when run headless, so kicad-cli is the only filler available.

The repo's writers (board populate, `move_footprint`, the sym-lib-table rewrite) splice spans located by `src/kicad/spans.ts` and never serialize a parse tree (SPEC §1.3). This design follows them.

## Goals / Non-Goals

**Goals:**

- One module that every caller (`run_drc`, `fill_zones`, the unrouted baseline, `check`, `export_outputs`) uses for fills, with one definition of "the fill KiCad would compute here".
- A board's diff after a refill is its fill data and nothing else, apart from ids given to zones that had none.

**Non-Goals:**

- Computing fills ourselves. KiCad's filler handles thermal reliefs, island removal, net-class and custom-rule clearances and hatching; reimplementing it is out.
- Upgrading or reformatting a board's format. A KiCad 8 board stays a KiCad 8 board.
- Filling zones inside a board KiCad cannot load. The refresh fails, and the caller's existing load errors apply.

## Decisions

### D1: Refill a scratch copy, splice fills back

`refreshZoneFills(boardPath, text?)` writes the board text to a fresh temp directory under the board's own file name, copies `<stem>.kicad_pro` and `<stem>.kicad_dru` beside it when they exist, runs `pcb drc --refill-zones --save-board` there, reads the saved copy back, and splices its fill data into the original text. It returns `{ text, changed, zones, report }`, where `report` is KiCad's DRC of the refilled copy. It never writes `boardPath`.

Alternatives: `--save-board` on the real file (PR #478). That upgrades and reformats the whole file and drops the project's own formatting, and it cannot be undone short of the rollback snapshot. Copying the refilled file over the original has the same problem. A parse-and-reserialize writer breaks the no-round-trip invariant.

### D2: The scratch copy carries the project's rule files

Net-class clearances live in `.kicad_pro` and custom rules in `.kicad_dru`, and KiCad finds both by the board's stem. Without them KiCad fills with default rules, producing fills that are wrong for the real project (see Context). `fp-lib-table` is not copied: library resolution does not affect fills.

### D3: Zones are matched by id; zones without one get a deterministic id first

Each top-level zone is keyed by its `uuid` (or `tstamp` in KiCad 6/7 files). A zone inside a footprint is keyed by the footprint's id plus its own. KiCad keeps these ids when it loads and saves. A zone with no id, or one whose id repeats an earlier zone's, would get a random id from KiCad and could not be matched. So, before the scratch copy is written, such a zone gets a uuid derived from a SHA-1 of its text and its position among zones, inserted after its net and layer children, using the token the file already uses (`uuid` or `tstamp`). The id is deterministic, so a second refresh changes nothing. A zone present in the original but missing from the refilled copy (KiCad dropped a degenerate outline) fails the refresh, naming it.

### D4: The splice touches only fill children and two flags

Per matched zone, the splice:

- removes every `filled_polygon`/`fill_segments` child, with the whitespace before it, and inserts the refilled ones where the first was, or after the zone's last child when it had none;
- re-indents each inserted block from the refilled file's style (tabs) to the original's (tabs from KiCad 8 on, two spaces before that and in hand-written boards), keeping the original's line endings (CRLF included, as #381 fixed for `edit_file`);
- turns `(fill` or `(fill no` into `(fill yes` when the refilled zone is filled, or inserts `(fill yes)` when the zone has no `fill` child;
- adds `(filled_areas_thickness no)` after `min_thickness` (or replaces `yes` with `no`) when the zone lacks it and either the refilled zone carries it or the original file's version is older than the refilled copy's. That is exactly the case where the original format still reads a missing token as a legacy fill.

Edits are collected as spans over the original text and applied back to front, as in populate.

### D5: The splice is checked by reading it back through KiCad

When the splice changed the board, the refresh writes the spliced text over the scratch copy and has kicad-cli load and save it without refilling (`pcb upgrade --force`). That copy and the refilled one are then written by the same KiCad, so for every copper zone, matched by key, the fill flag and the fill blocks (whitespace collapsed) must be identical. Any zone that differs, or that KiCad dropped, fails the refresh, naming it. This checks exactly what KiCad will read from the text the refresh returns: it catches a mis-spliced zone, a fill KiCad would read as legacy and inflate, and a future format change. It costs one load and save (6 s on the Jetson board in Risks, where a DRC takes 25 to 39 s). A splice that changed nothing is not checked, since the board already holds the fills KiCad computes. A board with no copper zones (only rule areas, or none) skips kicad-cli entirely.

The read-back was itself checked against plotted copper. On the fixture, the spliced board, KiCad's refilled copy and `pcb export gerbers --check-zones` of the unfilled board give identical F.Cu and B.Cu gerbers, and a fill read as legacy does not. The test suite keeps that comparison.

Where kicad-cli has no `pcb upgrade --force`, the refresh falls back to a plain DRC of the spliced copy and fails when any violation type has more findings than the refilled copy's DRC, or there are more unconnected items, naming the types.

Alternative: the DRC comparison alone, which the first version of this design used. It costs a full DRC, and it misses a fill that differs from KiCad's but breaks no rule, such as a thinner one.

### D6: `run_drc` refills only a board the run has already edited

`run_drc` refreshes when `ctx.editsUnlocked` and the board is in `ctx.filesTouched`. The board is then already in the rollback snapshot's scope and already owes a passing DRC, so writing fresh fills adds no new risk. The write updates the board and clears `ctx.lastDrc`, then DRC runs. It does not go through `markTouched`, which would call `ledger.onKicadEdit` and reopen drift and changelog after the agent had closed them: obligations that a fill change cannot affect. Alternatives: refill on every `run_drc` (writes during read-only runs and reports, PR #478's other flaw); refill only through `fill_zones` (the model must remember, and #469 asks for it to be automatic).

On a board the run has not touched, `run_drc` stays read-only. When its DRC fails, it refreshes in memory, and if the copy's DRC has fewer violations it says the fills are stale and points to `fill_zones`.

### D7: `fill_zones` is an ordinary board edit

`fill_zones` (`requiresUnlock: true`) refreshes and, when the text changed, writes the board and calls `markTouched`, so the run owes DRC, drift and a changelog entry like any board edit. A user asked for it, so it belongs in the record.

### D8: Two meanings of "stale", one per purpose

- `check` and read-only `run_drc` call fills stale when DRC fails and the refreshed copy's DRC has fewer violations. That tolerates the small coordinate differences between KiCad versions' fillers on a board nobody changed.
- `export_outputs` calls fills out of date when a refresh would change them at all, or a copper zone has none. Fab outputs must match the fill the running KiCad computes, and the committed board must match the fab outputs. The cost on a board filled by a different KiCad version is one `fill_zones` call.

Alternative for export: `pcb export gerbers --check-zones`, which refills in memory for the plot. That ships copper the committed board does not hold, and a reviewer reading the board would not see it.

### D9: The unrouted baseline is counted on a refreshed copy

`unroutedCount(boardText, boardPath)` places the starting text beside the project's rule files, refreshes, and counts KiCad's unconnected items on the refilled copy (the refresh's `report.unrouted`). When refill is unavailable or the refresh fails, it falls back to today's plain count. The `now === boardAtStart` shortcut in `unroutedGuard` stays: an unchanged board compares against itself.

### D10: Capability detection

`zoneRefillSupported()` runs `kicad-cli pcb drc --help` once per process and requires both `--refill-zones` and `--save-board` in its output. `boardResaveSupported()` likewise runs `pcb upgrade --help` once, when a splice first needs checking, and requires `--force` (D5). `resetKicadCliCache()` clears both. Without them, `run_drc` and `check` behave as today and say fills were not refreshed, `fill_zones` fails with the reason, and `export_outputs` checks only for zones with no fill data.

## Risks / Trade-offs

- [Fills made by a different KiCad version differ slightly from a kicad-cli refresh] → The first refill after an edit rewrites every zone's coordinates, a larger diff than the edit itself. This is the same as pressing B in that KiCad. `check` uses the DRC-based meaning, so it does not flag such a board.
- [Refill time on large boards] → One refill DRC and one load-and-save per refresh. On the copperbench Jetson Orin baseboard (36 MB, 240 zones, 117 pours) with kicad-cli 10.0.6: the refill took 25 to 39 s depending on machine load, the read-back 6 s, and copperhead's own text work about 13 s (each pass over the zones of a 36 MB file takes about 1 s), 48 to 58 s in all, on a board whose plain DRC `run_drc` already runs. A board without copper zones pays nothing.
- [A board filled by an older KiCad] → On the same Jetson board, a refresh by kicad-cli 10 changed 95 of 117 pours though nothing had moved: KiCad 10's filler draws slightly different polygons. This is why D8 keeps `check` on the DRC-based meaning of stale.
- [The legacy-thickness rule rests on observed KiCad behaviour] → D5's read-back fails loudly, naming the zone, if the rule is wrong for some version, rather than writing inflated fills.
- [KiCad drops a degenerate zone the agent wrote] → The refresh fails naming the zone; `run_drc` reports it beside a plain DRC, and the agent can fix the outline.
- [Temp-directory leak on a crash] → `mkdtemp` plus `rm` in `finally`, as `runCheck` and `unroutedCount` already do.

## Migration Plan

None. No board changes until a run edits it and calls `run_drc`, or calls `fill_zones`. Older kicad-cli keeps today's behaviour.

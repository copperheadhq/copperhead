## 1. Fixtures

- [x] 1.1 Add `test/fixtures/zones/`: a hand-written KiCad 8-format (`(version 20240108)`, two-space indent) board with GND, SIG and SIG2 nets, two through-hole connectors, an Edge.Cuts outline, and GND zones on F.Cu and B.Cu; a `zones.kicad_pro` that sets a 0.8 mm default clearance and ignores `lib_footprint_issues`/`lib_footprint_mismatch` (the footprints are inline). Variants: `unfilled` (outlines only, one zone without `filled_areas_thickness`, one without a uuid), `fresh` (filled by kicad-cli and spliced back by hand-checked text), `stale` (`fresh` with one connector moved into the pour). Verify with a test that plain DRC passes on `fresh` beside the project file and fails with a short or clearance on `stale`.

## 2. kicad-cli support

- [x] 2.1 In `src/kicad/cli.ts`, add `zoneRefillSupported()` (cached `pcb drc --help` probe requiring `--refill-zones` and `--save-board`, cleared by `resetKicadCliCache`) and `refillAndSave(scratchPath)` (DRC with `--refill-zones --save-board`, documented as scratch-copy only). Verify: a unit test with a stubbed help text returns false without the flags, and the real kicad-cli returns true (AC-22.7).

## 3. The zone filler (`src/kicad/zones.ts`)

- [x] 3.1 Zone listing over spans: top-level zones and footprint zones, each with key (uuid, tstamp, or footprint id plus zone id), fill children, `fill` child, `filled_areas_thickness`, and whether it is a copper zone (has a net and no keepout or rule-area). Verify with unit tests on inline texts, including a zone name holding `(` inside quotes.
- [x] 3.2 `assignZoneIds(text)`: a deterministic uuid for zones with no id or a repeated one, using the file's own id token. Verify: unit tests show the same input gives the same ids, a text with complete ids is returned unchanged, and the second of two duplicate ids is replaced (AC-22.5).
- [x] 3.3 `spliceZoneFills(original, refilled)`: the D4 edits (replace or insert fill children, re-indent, keep line endings, `(fill yes`, `filled_areas_thickness` rule), with an error naming any original zone the refilled text lacks. Verify with kicad-cli-free unit tests: text outside zones is byte-identical; an unfilled zone gains fills; tab-to-space re-indent; CRLF stays CRLF; `(fill` becomes `(fill yes`; a missing `fill` child is inserted; the thickness token is added only under the version rule; an unmatched zone throws.
- [x] 3.4 `refreshZoneFills(boardPath, text?)`: scratch directory with the board and its `.kicad_pro`/`.kicad_dru` under the board's name, refill, splice, D5 splice check, cleanup in `finally`, no kicad-cli run for a board without copper zones, and an error when refill is unsupported. Verify against the fixtures: `unfilled` gains fills in both zones with the version header unchanged and the file on disk untouched (AC-22.1); in-place DRC beside the 1.0 mm project passes (AC-22.2); the zone that lacked `filled_areas_thickness` gains it and has no clearance finding (AC-22.3); refreshing the output again reports no change (AC-22.4); a spliced text with a deliberately corrupted fill fails the D5 check (AC-22.6).
- [x] 3.5 Time a refresh on the copperbench Jetson baseboard fixture (240 zones) and record it in the PR description. (48 to 58 s with kicad-cli 10.0.6 after 3.6; recorded in design.md Risks.)
- [x] 3.6 D5 by read-back: `boardResaveSupported()` (cached `pcb upgrade --help` probe for `--force`) and `resaveBoard(scratchPath)` in `src/kicad/cli.ts`; `fillMismatches(refilled, readBack)` and a `verifySplice` that resaves the spliced copy and compares each copper zone's fill flag and fill data with the refilled copy's, falling back to the DRC comparison without `--force`; no check when the splice changed nothing. Verify: `fresh` with the F.Cu zone's thickness token removed fails naming only that zone, and `fresh` passes (AC-22.6); a kicad-cli wrapper that refuses `pcb upgrade` takes the DRC fallback and never resaves; F.Cu and B.Cu gerbers of the refreshed board equal those of KiCad's refilled copy and of `--check-zones` on `unfilled`, and differ for `unfilled` itself and for the legacy-read board.

## 4. Agent tools

- [x] 4.1 `run_drc`: when unlocked and the board is touched, refresh, write if changed, clear `lastDrc` without `markTouched`, then DRC in place; skip the refill while the board and rule files hash to the last refresh's (`ctx.fillsCurrent`). Otherwise read-only, with a stale-fill note when DRC fails and the refreshed copy is better. A refresh failure is reported beside a plain DRC. Verify with handler tests on the fixtures: `stale` moved inside an unlocked touched run passes and keeps its header (AC-22.8); a pour added by `edit_file` is filled and its pads stop counting as unrouted (AC-22.9); locked and untouched runs leave the board's hash unchanged and name the stale fills (AC-22.10); after drift and changelog are closed, a refilling `run_drc` reopens neither (AC-22.11); a second `run_drc` with no edit in between runs no refill (a recording kicad-cli wrapper).
- [x] 4.2 Rollback: a loop test where `run_drc` refilled and the run then fails, ending with a board byte-identical to its start (AC-22.12).
- [x] 4.3 `fill_zones` tool (`requiresUnlock: true`, registry hint, `markTouched` on write, "already current" when unchanged, failure when unsupported). Verify: absent from the locked tool list; on `stale` in an untouched run it writes, the board is touched, and `finish` refuses until `run_drc` passes (AC-22.13).
- [x] 4.4 `startingUnrouted(boardPath, text)` (src/capabilities/fills.ts) counts on a refilled copy beside the project files, falling back to plain `unroutedCount` when unsupported or failing; `unroutedGuard` calls it with the board path. Verify: a starting board whose stored GND fill joins J2's pad through a ring of no-net track that a fresh fill keeps clear of gives no `unrouted_increase` after an unrelated move (AC-22.14); the existing AC-15.39 tests still pass.
- [x] 4.5 `export_outputs` refuses, writing nothing, when a copper zone has no fill or a refresh would change the fills, naming the zones and `fill_zones`. Verify: `unfilled` refuses with an empty `outputs/` (AC-22.15), and `fresh` exports.

## 5. check

- [x] 5.1 `check`: unfilled copper zones reported from text; on a DRC failure, a refreshed scratch copy decides the stale-fill finding; `--json` gains `drc.fills` (`stale`, `staleAccountsFor`, `staleZones`, `unfilled`, `notChecked`); exit code unchanged; no extra kicad-cli run without copper zones. Verify: `stale` exits non-zero, prints the stale-fill finding, and the board's hash is unchanged (AC-22.16); `unfilled` lists the zone under `drc.fills.unfilled` with DRC's exit code (AC-22.17); the existing AC-2 tests pass.

## 6. Prompts

- [x] 6.1 Add to the `do` workflow (the verbatim §4.3 rules stay as they are) and the layout-draft stage text in `src/commands/create.ts`: `run_drc` fills the pours of a board the run changed; never write `filled_polygon` data; `fill_zones` refills on request. Verify with the existing prompt snapshot or content tests updated to assert the sentence.

## 7. Spec

- [x] 7.1 Update SPEC.md: §4.2 `run_drc` row (refill on an edited board) and a new `fill_zones` row; §First-draft layout (pours the agent adds are filled by `run_drc`); AC-15.39 (the starting count is taken on filled pours); a new "AC-22 · Copper pour fills (change: refill-zone-fills)" section listing AC-22.1 to AC-22.17. Verify: `openspec validate refill-zone-fills` passes.

## 8. Check

- [x] 8.1 `npm run typecheck`, `npm run build` and `npm test` pass in the worktree.

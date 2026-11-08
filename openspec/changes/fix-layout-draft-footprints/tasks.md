# fix-layout-draft-footprints: Tasks

## 1. Library tables and footprint resolution

- [x] 1.1 New `src/kicad/libtable.ts`: read `fp-lib-table`/`sym-lib-table` (project, then the newest global config dir; `KICAD_CONFIG_HOME` honored), expand `${VAR}`/`$(VAR)` with `KIPRJMOD`, follow nested `Table` rows, skip disabled and non-KiCad rows, first nickname wins
- [x] 1.2 New `src/kicad/footprints.ts`: `footprintSearchDirs` (env override exclusive, Linux/macOS paths, Windows version dirs, siblings of the stock symbol dirs); `FootprintResolver` with exact-id resolution and `KICADn_FOOTPRINT_DIR` defaults; misses carry `no-library`/`no-footprint`/`bad-id` and near ids
- [x] 1.3 `missingFootprints` and `formatMissingFootprints` (the stop message: parts, reasons, table row, install route, sources searched, resume point; no absolute paths)
- [x] 1.4 Tests: URI expansion, precedence, nested tables, disabled rows, project-only resolution, no substitution, the stop message

## 2. Board populate

- [x] 2.1 `exportNetlist` in `src/kicad/cli.ts`
- [x] 2.2 New `src/kicad/populate.ts`: `parseNetlist` (skip `#` refs and board-excluded parts; schematic paths), `instantiateFootprint` (anchored splices only), `footprintBounds` (pads, graphics, silkscreen text sized by the instance), `shelfPack`, `boardFootprints`, `boardMatchesNetlist`
- [x] 2.3 `populateBoard`: resolve all first, net codes by name, pack inside the outline (grow a lone scaffold `gr_rect`), splice net table and footprints, probe-load in a temp copy, then write; unchanged on an exact match, refused on a different set
- [x] 2.4 Tests against real kicad-cli: exact ids, pad nets equal the netlist, pad geometry byte-identical, DRC clean with schematic parity, idempotent and deterministic, missing footprint leaves the board byte-identical, project-local footprint, refusal on a mismatched board

## 3. Pipeline

- [x] 3.1 Footprint stop before the schematic stage (`bomFootprintStop`), no agent turn or diagnosis
- [x] 3.2 Populate before every layout-draft attempt (`populateStop`); stop on failure
- [x] 3.3 Layout-draft `isComplete` compares the board with the schematic; `contractGapDetail` names the difference
- [x] 3.4 Stage 5 prompt: move the populated footprints, never add or rewrite one
- [x] 3.5 Tests: the stop before the schematic stage with its message, resume after install, completion fails for outline-only, renamed, and swapped footprints

## 4. Schematic side

- [x] 4.1 `bomFootprintId` in `src/memory/bom-table.ts`; IR validation refuses an intent footprint that differs from BOM.md
- [x] 4.2 `SymbolSource` resolves from the project `sym-lib-table`; drafting keeps user rows
- [x] 4.3 Tests for both

## 5. Corpus findings

- [x] 5.1 Ran populate on the 4 reference boards and 10 real designs: every populated board DRC-clean with schematic parity; designs whose project libraries are absent stop with named parts
- [x] 5.2 Pin/pad mismatch (npn-switch Q1: C/B/E pins on SOT-23 pads 1/2/3) refused by populate and by the draft tool's IR validation
- [x] 5.3 Scaffold `min_through_hole_diameter` 0.2 mm (buck-12v-5v QFN thermal vias)
- [x] 5.4 Pack rows at least sqrt(total area) wide, so large designs grow the outline both ways
- [x] 5.5 Tests for 5.2 and 5.3

## 6. Unrouted connections

- [x] 6.1 `normalizeReport` keeps `unconnected_items` out of `violations`; `CheckReport.unrouted` counts them; `formatViolations` and `check` show the count
- [x] 6.2 Stage 5 prompt: unrouted nets are allowed and go in Draft quality
- [x] 6.3 Tests: ratsnest-only DRC is clean; a real violation still fails beside unrouted ones

## 7. Part selection verifies footprints (found in the live run)

- [x] 7.1 `bomFootprintRows`: footprints only from tables with a Footprint column, first row per refdes; the IR cross-check uses it and keeps the first BOM row per refdes
- [x] 7.2 `check_footprints` tool (query, no unlock) and footprint-aware near-name ranking
- [x] 7.3 Part-selection completion requires resolvable footprints (except an uninstalled library); gap detail lists misses with suggestions; prompt requires check_footprints
- [x] 7.4 Tests: table selection, tool output with a one-digit slip, the gate's three outcomes

## 8. Library-intrinsic DRC findings (found in the live run)

- [x] 8.1 `footprintOwner`; `normalizeReport` moves single-footprint DRC findings to `CheckReport.intrinsic`; `formatViolations`, `run_drc`, and `check` report them
- [x] 8.2 Stage 5 prompt: name them in Draft quality, never try to fix them
- [x] 8.3 Tests: same-footprint finding is clean and listed; two-part and track findings still fail

## 9. Moving footprints (found in the live run)

- [x] 9.1 `moveFootprint`: rotate pad, property, and text angles with the footprint, by anchored splices
- [x] 9.2 `move_footprint` tool (spec-gated mutation, load-probe with revert); Stage 5 prompt forbids hand-editing placement
- [x] 9.3 `normalizeReport` never excuses findings inside a footprint KiCad reports as modified
- [x] 9.4 Tests: moveFootprint rotation passes DRC with no mismatch; a hand rotation fails; the tool is gated

## 10. Spec

- [x] 10.1 SPEC.md: pipeline diagram, the one stop, the populate bullet, AC-15.29 – AC-15.38; AC-15.23/24's layout-draft clause marked superseded

## 11. Review fixes (PR 319)

- [x] 11.1 `normalizeReport` never excuses a finding that puts two nets against each other, or one inside a footprint with `lib_footprint_issues`; tests for a short and a clearance across nets inside one footprint
- [x] 11.2 Layout-draft keeps the pre-stage board: restores it before each retry and on every unsuccessful exit; populate's board must pass DRC before the first turn (naming a missing global `fp-lib-table`); the run gets the board as `preTouched`; pipeline tests for each
- [x] 11.3 `run_drc` in an agent run fails when unrouted connections rise above the run's starting board (`unrouted_increase`); `check` keeps counting them
- [x] 11.4 Layout-draft completion and populate's idempotence compare pad nets with the schematic netlist
- [x] 11.5 Drafting keeps user `sym-lib-table` rows as whole source spans (`src/kicad/spans.ts`) and refuses an unparseable table; `SymbolSource` reads the table beside the schematic
- [x] 11.6 Library tables expand `${KICADn_3RD_PARTY}` and `kicad_common.json` variables
- [x] 11.7 Populate accepts KiCad 5 `(module …)` files, sorts locale-independently, and bounds the pack by an outline it cannot grow
- [x] 11.8 Scaffold `.kicad_dru` holds board vias to a 0.3 mm drill
- [x] 11.9 Test fixtures use real footprint ids; `check`'s DRC keys updated; DRC tests run against a seeded KiCad config, not the machine's
- [x] 11.10 SPEC.md AC-15.30/31/36–44 and the populate bullet; delta specs; design.md

## 12. Follow-up review fixes (PR 319, second pass)

- [x] 12.1 `joinsNets`: only `shorting_items` joins nets; a clearance between a footprint's own pads stays intrinsic across nets (stock USB-C receptacles)
- [x] 12.2 Populate and `moveFootprint` move and turn a footprint's zones, at 1 nm resolution; test: three stock ESP32 modules off-origin, and moved at 90 and 45 degrees
- [x] 12.3 `unroutedGuard` skips the comparison when the starting board does not load
- [x] 12.4 A failed layout-draft stage restores the board an attempt committed, when one did; test with a committing attempt
- [x] 12.5 Library tables, path variables, and the stock-directory default follow the running `kicad-cli`'s major version; library-table paths are normalized
- [x] 12.6 `.kicad_dru` is a managed path; layout-draft completion requires a passing DRC; the Stage 5 prompt and the missing-library hint say only what is true
- [x] 12.7 An outline populate cannot grow must hold every packed part inside its real shape (L-shapes, cutouts)
- [x] 12.8 Tests: a seeded KiCad config for the pipeline tests (`seededKicadConfig`), platform pinned in the path-variable tests, a loop-level `preTouched` test
- [x] 12.9 SPEC.md AC-15.30/36/38/39/41/42/43, the populate bullet, delta specs, design D2/D4/D6/D8

## 13. Codex review of d4bdbd7

- [x] 13.1 Symbols from a project library are read in place, never vendored, so the user's `sym-lib-table` row stays the source; test: a second draft reaches another symbol in the same library, and ERC reports no `lib_symbol_mismatch`
- [x] 13.2 Populate remaps every object id inside a placed footprint per instance, deterministically; test: two instances of a stock footprint with nested ids share none, and DRC reports no mismatch
- [x] 13.3 The missing-footprint stop runs before the KiCad project is scaffolded, so it writes no KiCad file; test asserts no scaffold files after the stop
- [x] 13.4 SPEC.md AC-15.31/32/36, delta specs, design D1/D7

## 14. Review of the unreleased main (post-0.11)

- [x] 14.1 Layout-draft completion needs something written under Draft quality: the placeholder `copperhead init` scaffolds no longer passes now that populate fills the board before the first turn; the gate reads the document first, then the netlist, then DRC; test: a populated, DRC-clean board with the scaffolded section does not complete
- [x] 14.2 A DRC finding counts as library-intrinsic only when its items name one annotated reference no other footprint on the board carries; tests: `REF**`, `R?`, and a reference two footprints share
- [x] 14.3 Populate replaces the net table a footprint-less board kept, and refuses one whose old nets still carry copper; tests for both
- [x] 14.4 A project library is read before a vendored cache file under its nickname; test: a partial cache file does not shadow the user's library or replace its row
- [x] 14.5 SPEC.md AC-15.31/37/38/41, delta specs
- [x] 14.6 Second review, of this section's fixes: a stale net is removed by its own span unless alone on its line (a shared line no longer eats `(net 0 "")`); only copper on a net (tracks, vias, zones, copper shapes, by code or name, in the old table or not) refuses the board, so a keepout passes, and a line only stale nets fill goes whole; the gate keeps the stray-root hint for an empty section and names a duplicate heading; post-run gaps reuse the finish gate; DRC reads the board before KiCad and excuses nothing when it cannot; the project-library check answers non-project nicknames from the table text, matching copperhead's cache rows by their URI; the post-run gap skips the DRC isComplete just ran; the off-catalog nudge offers propose_change only where the turn does, so skill sub-runs pass provider nudges through
- [x] 14.7 Outside this change, recorded here: calls after an accepted `finish` are not run (`build-copperhead-phase-1` agent-core), and skill sub-runs send the fabricated-result notice (`add-claude-code-provider`, `add-cursor-cli-provider`); SPEC.md §4 step 5 and AC-3.21
- [x] 14.8 Codex on PR #389: the copper check runs on every footprint-less board, not only one that still declares old nets; test: a track on code 1 with the old table already gone is refused

## 15. Placing Reference text (#380)

- [x] 15.1 `moveFootprint` takes an optional board-coordinate label point and writes the Reference text's `(at …)` as `R(-θ)·(board - origin)`, with the new origin and angle when the call also moves or turns the part; the `property "Reference"` and KiCad 6 `fp_text reference` forms, keeping `unlocked`
- [x] 15.2 `move_footprint` takes `label_x`/`label_y` (both or neither), and its result names where the text went; the Stage 5 prompt sends refdes label fixes to it instead of `edit_file`
- [x] 15.3 Tests: the local frame at 0/90/180/270 degrees, turning and placing in one call, label-only, `fp_text`, unchanged output without a label, argument checks, the prompt; checked against pcbnew 10.0.7 on front and back footprints
- [x] 15.4 SPEC.md AC-15.42, delta spec, proposal
- [x] 15.5 Review of PR 408: a label-only call (same origin and angle) leaves the footprint's `(at …)` and its owned zones byte-for-byte as written, and a call that changes nothing returns the board unchanged; tests compare the complete output with a footprint-owned zone in KiCad's `100.000000` spelling

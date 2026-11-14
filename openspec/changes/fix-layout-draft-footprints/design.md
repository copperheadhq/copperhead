# fix-layout-draft-footprints: Design

## Context

Stage 5 could not put a real footprint on the board (#314), so the agent hand-wrote pad geometry and DRC rejected it. `kicad-cli` 10 has no schematic-to-board update, so copperhead populates the board itself before the agent's first layout turn. That step sits between two invariants (SPEC §1.3): KiCad files change only by anchored text splices, and no mutation is done until DRC passes, with rollback to the run's git snapshot otherwise. Populate runs in the pipeline, outside the agent loop that normally enforces both, so this design says how it keeps them.

## Goals / Non-Goals

**Goals:**

- Every schematic part reaches the board with its exact library footprint and pad nets, or the run stops for the user.
- The populated board is verified before the agent works on it, and is never left behind unverified.
- DRC distinguishes what layout can fix (placement, routing, clearance, shorts) from what it cannot (a stock footprint's own geometry, nets not yet routed).

**Non-Goals:**

- Updating an already-placed board after a schematic change: populate fills an empty board only.
- Placement quality and routing (#141), and fetching parts that are not installed.

## Decisions

**D1. Populate splices library text; the parser stays read-only.** Each `.kicad_mod` is copied with its refdes, value, uuid, placement, schematic link, and pad nets spliced in, using bracket-matched source spans (`src/kicad/spans.ts`). Pad geometry is carried over byte-for-byte. The one exception is a footprint's own zones (an ESP32 module's antenna keepout): a board stores them in board coordinates, unlike pads and graphics, so populate and `move_footprint` move and turn their points with the part, at KiCad's 1 nm resolution, or KiCad reports the footprint as modified. Object ids inside the footprint (about a fifth of the stock library carries them) are remapped per instance, derived from the instance's uuid and the library's id, as KiCad gives a placed footprint fresh ids; two instances of one footprint would otherwise share every id. The alternative, building footprints from a parse tree, would serialize s-expressions, which SPEC §1.3 rules out, and would drift from the library whenever the serializer and KiCad disagree.

**D2. The pipeline owns the populate mutation, and the loop verifies it.** Populate writes before `runAgentLoop` takes its snapshot, so the loop's rollback cannot undo it. Rather than moving populate into the loop (which would put a pipeline concern into every `do` run), the layout-draft stage keeps the pre-stage board bytes itself. Before each retry it restores the last verified board: the board an earlier attempt committed, when that board still matches the schematic, so a DRC-clean placement is not redone over a documentation gap (#327); otherwise the pre-stage bytes, which populate then fills again. Populate is idempotent on a populated board, so a committed board is re-checked, not rewritten. On every exit that does not complete the stage, including a thrown error, it puts back the last verified board: the pre-stage board, or, if an attempt committed (which means its DRC passed), that commit's board, so the tree never ends up reverting HEAD. The stage's completion contract also requires a passing DRC, so a run killed before its `run_drc` passed cannot resume as complete. The board must pass DRC right after populate, and the loop receives it as `preTouched`, so the same finish gate that governs `edit_file` requires a passing `run_drc` even when the agent never touches the board.

**D3. Unrouted connections are a count for `check`, and a ceiling for an agent run.** A draft board is fully unrouted by design, so `check` counts `unconnected_items` beside a clean result instead of failing on them. An agent run, though, must not break a connection. The loop records the board text at the start, and `run_drc` fails with `unrouted_increase` when the count rises above that board's count. The baseline is measured on the first `run_drc`: it reuses the report when the board is unchanged, and runs DRC on a temp copy of the starting text otherwise. A starting board KiCad cannot load has no count, and the comparison is skipped. Scoping the relaxation to layout-draft alone was considered and rejected: `check` would then fail on every board `create` produces until a human routes it.

**D4. "Library-intrinsic" means KiCad vouches for the footprint and no two nets short.** A finding is excused only when every item belongs to one footprint, it is not a `shorting_items`, and KiCad reports neither `lib_footprint_mismatch` nor `lib_footprint_issues` for that footprint. A short between two nets inside one stock part is a schematic wiring fault, and a footprint KiCad could not compare with its library is not known to be the library's. A clearance between a footprint's own pads is the library's geometry even across nets: a stock USB-C receptacle's DP and DM pads sit closer than the board rule, and failing that stopped every design using one. Treating every cross-net finding as a fault was tried and reverted for that reason.

**D5. Board-to-schematic comparison reads pad nets directly.** The layout-draft gate and populate's idempotence check compare each pad's net with the `kicad-cli sch export netlist` net. `pcb drc --schematic-parity` was considered, but it silently reports nothing when no schematic shares the board's basename, and a gate that can pass by not finding its input is not a gate.

**D6. Library tables follow the running KiCad, and expand the variables it defines.** The global table, its path variables, and the stock-directory default are the running `kicad-cli`'s major version's, read once per process; a machine with KiCad 9 and 10 installed must resolve what the `kicad-cli` doing DRC resolves, not whatever is newest. Table URIs expand `${KIPRJMOD}`, `${KICADn_FOOTPRINT_DIR}` (defaulted to the stock directory), `${KICADn_3RD_PARTY}` (KiCad's default per-user location, where the Plugin and Content Manager installs libraries), and the user's `kicad_common.json` variables, with the process environment taking precedence. A row whose variable stays undefined is skipped, as KiCad shows it unavailable.

**D7. User library-table rows are preserved as source spans.** Drafting rewrites the vendored rows of the project `sym-lib-table`. It keeps each user `(lib …)` row as its exact source text, whatever its layout, and refuses to rewrite a table that does not parse, rather than filtering lines, which truncated multi-line rows. Symbols from a project library are never vendored: a vendored copy holds only the symbols used so far, and replacing the user's row with it hid the rest of the library from the next draft.

**D8. An outline populate cannot grow still bounds it exactly.** A single rectangle grows to fit. Any other outline (an L-shape, rounded corners, mounting-hole cutouts) is flattened to segments and every packed part must lie inside it by even-odd test with no edge crossing it; otherwise populate stops before writing. Packing around a cutout was not attempted: the agent places parts next, and the scaffold's outline is a rectangle.

## Risks / Trade-offs

- [Every layout-draft attempt costs a DRC run after populate, and a baseline DRC when the board changed before the first `run_drc`] → Each run takes seconds against a stage that takes minutes of model time.
- [A retry discards the previous attempt's placement work] → Only when that attempt did not commit, or committed a board that no longer matches the schematic. A committed, matching board is kept for the retry; the retry guidance carries what went wrong.
- [A machine without a global `fp-lib-table` resolves footprints through the stock fallback but fails KiCad's DRC] → Populate's DRC stops the run and names the missing table and how to seed it.
- [The 0.2 mm hole minimum could admit 0.2 mm board vias] → The scaffold's `.kicad_dru` holds vias to a 0.3 mm drill.

## Open Questions

- Should a board populated before a schematic rewire be updated in place (a real schematic-to-board update) rather than refused? Out of scope here; populate refuses and names the differing pads.

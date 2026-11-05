# structured-part-selection: Design

## Context

See proposal.md — Why, and #459 for the audit. Stage 4 already has the shape this change gives stage 3: a model-authored intent file (`schematic.intent.json`), a deterministic engine (`draft_schematic`) that validates it and writes the artifact, and gates that ask the engine rather than parse prose. Stage 3 today has a prompt, a markdown table read four different ways (positional predicate, `bomFootprintRows`, `parseBomTable`, dossier name-match), and a gate that checks a proxy. The two invariants (SPEC §1.3) hold throughout: the manifest and BOM.md are docs, so edit tools stay spec-gated and nothing here touches a KiCad file; `check` stays LLM-free and network-free, and so does every validator this change adds.

## Goals / Non-Goals

**Goals:**

- Every rule the stage-3 prompt states today becomes a validator finding that names a refdes and a fix, surfaced inside the run at `draft_bom` and at `finish`, not after a rollback.
- The symbol the stage verified is recorded and reused: stage 4 and the dossier read lib_ids, never guess them.
- Part count stops driving turn count: one `draft_bom` call validates the whole manifest.
- Repos without a manifest behave exactly as before.

**Non-Goals:**

- Turn budget, retry escalation, stash reapply (#446, #135).
- Fetching uninstalled symbols or footprints (#238); copperhead still never downloads parts.
- Changing BOM.md's five canonical columns or the readers `export bom`, drift and `explain` use for a hand-written BOM.

## Decisions

**D1. A JSON manifest the model writes, not a richer markdown table.** BOM.md stays the human document but becomes an output. Alternatives: (a) keep BOM.md as the authored artifact and add a Symbol column plus a stricter parser; (b) a manifest. (a) leaves four readers of prose and keeps formatting rules in the prompt, which is the structural fault being fixed. (b) matches stage 4 exactly, gives one schema, and lets the renderer own formatting. The manifest lives at `docs/parts.intent.json` next to the docs it renders into, not beside the schematic: it exists before any KiCad project does, and the schematic path is not known until the scaffold runs.

**D2. One validator, three callers.** `validatePartsManifest(manifest, { symbols, footprints, subsystemsMd })` returns findings. `draft_bom` calls it and renders on clean; the stage's `isComplete` calls it and additionally requires BOM.md to equal the render; the finish-time `stageGate` calls it so the model hears the gap before commit; `contractGapDetail` formats the same findings. There is no second source of truth to drift from the first. The validator is pure over injected resolvers so it tests with fixture libraries.

**D3. Passives expand from package, actives declare lib_id.** A part whose refdes prefix is R, C, L, D, LED, Y, F, FB, SW, TP and whose entry gives `package` gets its canonical `Device:*` (or the library the table names) symbol and the stock footprint id from a mapping table in `src/kicad/parts/passives.ts`. An entry may still give an explicit `libId`/`footprint` and the table is then skipped. Alternatives: let the model type the two hundred ids by hand (today), or infer from Value. The table is small, exact, and the one place a package convention lives; Value inference is guessing.

**D4. Pin-versus-pad check moves to stage 3.** The IR validator's pad check (`ir.ts`, the `#314`/`#325` block) is lifted into a shared function used by both validators. Finding it at stage 3 means the fix is one manifest field; at stage 4 it meant editing BOM.md and re-drafting. Stage 4 keeps running it, since a manifest-less repo still needs it.

**D5. Off-board is a declared exemption, not an empty cell.** `offBoard: true` exempts an entry from symbol, footprint and pad checks, from the stage-4 IR, from the pre-schematic footprint stop, from populate and from drift. The renderer marks the row (`(off-board)` in the Footprint cell) and `bomFootprintId` learns that marker so every existing reader treats it as "not a footprint" rather than a miss. An empty footprint on a non-off-board active part remains a finding. Alternative considered: treat `TBD`/`n/a` as off-board; rejected because that is how a forgotten footprint looks.

**D6. Substitutions are explicit and rendered.** A `substitutions` entry needs `ref`, `wanted`, `chosen`, `reason`. The renderer writes a `## Substitutions` section into BOM.md, and the validator requires every entry's `ref` to exist with `chosen` as its value or MPN. The stage prompt says a swap forced by the library goes there; the existing DECISIONS obligation applies to the run as before. Nothing in this change makes copperhead fetch the wanted part.

**D7. UNVERIFIED is rendered, never typed.** The manifest carries `verified: boolean` (default false). The renderer writes the MPN cell as `<mpn> (UNVERIFIED)` when false. `parseBomTable` already strips the flag word for the dossier path; the stage predicate no longer looks at the MPN cell at all. This removes the prompt-versus-predicate contradiction by construction.

**D8. Manifest is authoritative when present; absent, nothing changes.** Every consumer checks for `docs/parts.intent.json` first: stage 4 IR validation takes parts from it and skips the BOM.md cross-check for refs it covers; the dossier resolves its lib_ids exactly and falls back to name-matching only for a manifest-less BOM; drift adds "BOM.md matches its render" as one item; `isComplete` for stage 3 uses the validator. With no manifest, the predicate, dossier, cross-check and drift are the pre-change code paths, so `do`/`sync` on hand-written projects and resumed older create runs are untouched. The positional MPN test is deleted in both cases: a manifest-less resume of an old run completes on the footprint check alone, which is the part of the old predicate that was ever meaningful.

**D9. Cache by file mtime under `.copperhead/cache/`.** `resolveLibrarySymbol` and `readFootprintPads` gain an in-process map keyed by (library file, mtime) and a JSON spill to `.copperhead/cache/` written at process end and read at start. The directory ignores itself (a `.gitignore` of `*` inside it, the response cache's pattern), so the user's .gitignore is never edited; the loop's rollback is `git reset --hard` plus `git clean -fd` without `-x`, so the cache survives a failed attempt. A stale entry is impossible by construction (mtime is in the key); a missing or corrupt cache file is ignored. Alternative: in-process only; rejected because the retry is a new attempt in the same process but `check` and stage 4 are not.

**D10. The stage prompt describes the task, the tool describes the format.** The manifest schema and every rule live in the `draft_bom` tool description and its findings. The prompt says what to design and which file to write. A rule that needs a prompt sentence to be followed is a rule the validator is missing.

**D11. No-part is a declared exemption, like off-board.** The first live run (USB-C breakout, 2026-11-05) showed the gap: the MPN rule covers every non-passive entry, a mounting hole is one, and the model satisfied the rule with a description in `mpn` ("NPTH-3.2mm (fab-drilled, no purchased part)"). `noPart: true` marks a board feature with nothing to buy (a mounting hole, a fiducial, a pad test point): it stays on the board, so its symbol, footprint and pads are checked as usual, and only the MPN rule is waived. `noPart` with an `mpn`, or with `offBoard`, is a finding. The render writes `(no part)` in the MPN cell; readers flag it `NO_PART`, never `MISSING_MPN`. Alternative: exempt by library (`Mechanical:`, `MountingHole:`). Rejected: those libraries also hold purchased parts (heatsinks, Keystone test points), so the library cannot decide.

**D12. The supplier export reads the render for what it is.** `export bom` reads BOM.md, so the render's additions must not become order lines. `parseBom` reads only tables that carry a Refdes header, each by its own header (the Substitutions table, or a cost table, is not parts); the orderable MPN is the cell without its `(UNVERIFIED)` annotation, with the flag carried on the row; a no-part row is on no order and raises no warning; an off-board row stays on a distributor cart (it is bought) and is left off the JLCPCB assembly BOM (it is never placed), with a notice. Alternative: have `export` read the manifest directly. Rejected for this change: BOM.md is the export's one input by its own spec (it is the drift-checked document), and a manifest-less repo must keep exporting.

**D13. A manifest that does not parse is reported, never skipped.** `loadManifest` returns `absent`, `invalid` (with the shape findings) or `ok`. The readers that enforce the manifest act on `invalid`: drift reports `parts.intent.json` as not a valid manifest, and the IR validator adds a finding instead of returning to the BOM.md cross-check. Only the pin dossier, which uses the manifest as a convenience, treats invalid as absent. Before this, a truncated manifest made `check` pass against the old BOM.md.

## Risks / Trade-offs

- [A large manifest is one big write, the single-point-of-failure pattern of #145] → The prompt tells the model to write it per subsystem with `edit_file`; `draft_bom` validates whatever is present and reports which SUBSYSTEMS.md headings have no parts yet, so partial progress is checkable.
- [The first `draft_bom` on a big board returns dozens of findings] → Findings are grouped by refdes and capped per call with a count, and each names the nearest installed id, so one edit round fixes a class of them. Two or three rounds is the expected case.
- [Passive expansion table disagrees with a user's library convention] → Explicit `libId`/`footprint` on the entry always wins; the table is only a default.
- [BOM.md drift when a user hand-edits the rendered file] → `check` reports it as drift naming the manifest; `sync` re-renders. The header line on BOM.md says where to edit.
- [Validator runtime on each call] → With the mtime cache it is one parse per distinct library on a cold machine and sub-second warm. Without the cache the first call on a big board is a few seconds; the cache is in scope, not optional.
- [Existing stage-3 tests and the symbol-pin-dossier change's "Stage 3 availability probing" requirement assume per-part tool calls] → Replaced by the validator requirements in the delta spec; the tools remain available.

## Migration Plan

1. Land the validator, renderer and tool behind the manifest's presence (D8): no behaviour change for existing repos.
2. Switch the stage-3 predicate and prompt. A create run resumed past a completed stage 3 with no manifest completes on the footprint check; a run resumed inside stage 3 writes the manifest on its next attempt.
3. Switch stage 4 and the dossier to read the manifest when present.
4. Add the cache.
Rollback at any step is reverting that step; the manifest file is a doc and harmless to leave behind.

## Open Questions

- Whether `sync` should regenerate `parts.intent.json` from an as-built schematic for repos that adopted copperhead after the fact. Deferrable: today those repos have no manifest and keep the old path.

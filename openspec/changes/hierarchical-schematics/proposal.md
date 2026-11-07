# hierarchical-schematics: Proposal

## Why

A 160-part flat sheet (lemondrop, `run-logs/2026-08-07T17-52-03`) spends most of its stage-4 iteration on density symptoms of "everything on one sheet": paper-size escalation chasing text collisions, whole-sheet re-emission (~40k tokens of IR context) to fix one group, whole-sheet blast radius when a late edit regresses (the lost-work problem tracked as R6/I16), and a router working around every other group's stub columns (the #204 net-merge class shrinks with fewer foreign columns per sheet). Past ~200 parts a flat sheet also stops being reviewable by a human at all. The hierarchy is already present semantically: every IR part names a `group`, and the engine already separates in-group nets (wires) from cross-group nets (labels), so the child-sheet partition and the sheet-pin set are derivable without new model-authored input. Tracked as #207.

## What Changes

- **Hierarchical emission**: above a configured part-count threshold (or on an explicit IR hint), the engine emits one child sheet per SUBSYSTEMS.md group (`<project>-<group>.kicad_sch`) plus an auto-generated top sheet: one sheet symbol per group, sheet pins derived from the cross-group net set, title block on the top sheet. Flat single-sheet emission remains the default below the threshold. **BREAKING** for the drafting contract: the "one `(kicad_sch` document" and "groups tiled left to right on one sheet" behavior pinned by the AC-16 contracts becomes mode-dependent.
- **Cross-group nets become hierarchical labels**: within a child sheet, cross-group connectivity is drawn as hierarchical labels matched by sheet pins on the top sheet, replacing the flat sheet's global net-label convention for inter-group nets. In-group wiring, reductions, placement, and alignment rules are unchanged per sheet.
- **Stage 4 becomes a per-sheet loop**: draft, validate, and repair one child sheet at a time with findings scoped to that sheet; each clean sheet is separately committable, and a regression in one sheet cannot discard another's completed work.
- **Gates split by scope**: legibility, scoring, and wire-contact checks run and gate per sheet (the checker already walks hierarchies and attributes findings per sheet); ERC runs once across the whole hierarchy via `kicad-cli`, which handles hierarchical designs natively.
- **Sheet-qualified drift and identity**: the drift checker and the emitter's UUIDv5 semantic paths become sheet-qualified, so per-file byte-identical regeneration and drift attribution survive the multi-file layout.
- **Golden corpus gains hierarchical fixtures**: Tier C reference IRs that draft to a hierarchy, pinned per file; existing flat goldens stay pinned as the below-threshold behavior.

## Capabilities

### New Capabilities

- `schematic-hierarchy`: the partition rule (one child sheet per group), the top-sheet derivation contract (sheet symbols, sheet-pin set from cross-group nets, title block), file naming, the flat-versus-hierarchical mode decision, and hierarchy-wide ERC invocation.

### Modified Capabilities

- `schematic-drafting-engine`: the single-sheet regeneration contract becomes per-sheet; cross-group connectivity switches from global net labels to hierarchical labels in hierarchical mode; per-sheet paper sizing.
- `schematic-emission`: multi-file emission with per-file canonical formatting and byte-identical regeneration; UUIDv5 semantic paths gain a sheet qualifier; top-sheet elements (sheet symbols, sheet pins) join the emitter's template set.
- `create-pipeline`: the schematic stage's completion contract and repair loop become per-sheet (draft, gate, commit sheet by sheet), with hierarchy-wide ERC as the final stage gate.
- `schematic-scoring`: scores are computed per sheet and rolled into a reported aggregate; the golden corpus gains hierarchical Tier C entries.
- `agent-core`: the drift checker resolves and reports sheet-qualified paths; drafting-mode tool findings carry the sheet they came from.
- `cli-surface`: `draft schematic` and `score schematic` accept a sheet selector and report per-sheet results; `check --json` legibility output is already sheet-attributed and gains the aggregate score shape.

## Impact

- **Code**: `src/kicad/draft/` (partition, per-sheet placement, hierarchical-label routing), `src/kicad/emit.ts` (multi-file output, sheet-symbol/sheet-pin templates, sheet-qualified UUID paths), `src/kicad/score.ts` (per-sheet plus aggregate), `src/memory/drift.ts` (sheet-qualified paths), `src/commands/create.ts` (per-sheet stage-4 loop and completion contract), `src/commands/check.ts` and `src/commands/draft.ts`/`score.ts` (sheet selection and reporting).
- **Fixtures**: hierarchical Tier C golden IRs with pinned per-file outputs and scores; the flat goldens remain pinned unchanged as below-threshold behavior.
- **Docs**: the schematic-drafting reference page gains a hierarchy section; the drafting standard states the partition and top-sheet rules.
- **Invariants**: unchanged. The sexp parser still never serializes; `check`, `draft`, and `score` stay LLM-free and network-free; spec-gating and verification-gating are untouched.
- **Ordering**: this change modifies requirements introduced by `deterministic-schematic-drafting`, so that change must archive first. Implementation is sequenced after the first end-to-end green run on the flat pipeline (per #207: flat sheets are not the current blocker, and landing this earlier would churn the golden corpus mid-campaign).
- **Out of scope**: hierarchy deeper than one level (top sheet plus children), model-chosen partitions that differ from SUBSYSTEMS.md groups, PCB layout implications, and any change to the viewer (Phase 2) or integrations (Phase 3).

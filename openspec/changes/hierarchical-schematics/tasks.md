# hierarchical-schematics: Tasks

> Sequencing gate: do not start until `deterministic-schematic-drafting` is archived and the first end-to-end green `create` run has landed on the flat pipeline (proposal, Ordering). The migration plan's order below keeps flat mode byte-identical at every step.

## 1. Sheet-qualified identity (flat mode must not move)

- [ ] 1.1 Add the sheet qualifier to the emitter's UUIDv5 semantic paths (`<sheet>/R1`, `<sheet>/wire/<net>/<index>`) with the flat sheet's qualifier chosen so existing flat output is byte-identical; prove it by the unchanged flat Tier C goldens (AC-17.1 groundwork)
- [ ] 1.2 Derive symbol `(instances …)` project paths from the UUIDv5-stable root-sheet identifier in the emitter templates
- [ ] 1.3 Extend the read-only parser's accessors to resolve sheet symbols, sheet pins, and hierarchical labels (no serialization)

## 2. Mode decision and validation

- [ ] 2.1 Add `hints.hierarchy` (`"flat"` | `"hierarchical"`) to the IR schema and validation, and `legibility.hierarchyThreshold` to the config block with a documented default
- [ ] 2.2 Implement the deterministic mode decision (threshold, hint override both ways) and state it with its reason in the draft report (AC-17.2)
- [ ] 2.3 Add validation findings for colliding sheet slugs (two groups sanitizing to one file name) and for a group whose banded content fits no standard sheet, both failing before placement

## 3. Hierarchical drafting and emission

- [ ] 3.1 Implement the child-sheet partition: per-group drafting through the existing per-group pipeline, one captioned group per sheet, file naming `<project>-<slug>.kicad_sch` (AC-17.3)
- [ ] 3.2 Switch cross-group nets to hierarchical labels in the child sheets' stub columns in hierarchical mode, keeping net labels for in-group nets
- [ ] 3.3 Implement top-sheet derivation: sheet symbols in shelf-wrapped group flow order sized from pin counts, sheet pins from the cross-group net set (side from stub side, ordered side-then-name), stub wires with net labels, populated title block (AC-17.4)
- [ ] 3.4 Add emitter templates for sheet symbols, sheet pins, and hierarchical labels; emit the hierarchy as an atomic file set (a failed draft leaves every previous file untouched)
- [ ] 3.5 Cross-check emitted hierarchies in tests: parse from the root, resolve connectivity across sheet boundaries, compare to the IR's connection list (AC-17.8)
- [ ] 3.6 Verify per-file byte-stability: a one-group IR change re-emits only that child sheet, plus the top sheet only when the cross-group net set changed (AC-17.6, AC-17.7)

## 4. Gates over the hierarchy

- [ ] 4.1 Run ERC once from the root sheet in hierarchical mode and confirm `kicad-cli` loads and checks the drafted hierarchy in CI (AC-17.5)
- [ ] 4.2 Teach the legibility checker the top-sheet vocabulary: sheet symbols and sheet pins participate in overlap/off-grid/out-of-frame; child sheets check normally under the existing hierarchy walk
- [ ] 4.3 Implement per-sheet scoring with the placed-part-count-weighted aggregate and the any-sheet error cap naming its sheet (AC-17.11)
- [ ] 4.4 Make the drift checker resolve and report sheet-qualified paths (AC-17.13)

## 5. Per-sheet stage loop

- [ ] 5.1 Track legibility ledger obligations per sheet, so committing a clean sheet is possible while another sheet's obligation stays open and `finish` still refuses on any open sheet
- [ ] 5.2 Restructure stage 4 into the per-sheet loop: full-hierarchy draft, then iterate the first dirty sheet with findings scoped to it, committing each clean sheet as it lands (AC-17.9)
- [ ] 5.3 Extend the stage completion contract: every sheet clean, hierarchy matches a re-draft across every file, hierarchy-wide ERC passes, per-sheet and aggregate scores recorded; one dirty sheet holds the stage naming that sheet (AC-17.10)
- [ ] 5.4 Scope stage rollback to the dirty sheet's uncommitted diff, preserving committed clean sheets

## 6. CLI, corpus, and docs

- [ ] 6.1 Print per-file draft reports and per-sheet score output from `draft schematic` and `score schematic`; add `legibility.score.sheets` to `check --json` with the one-record flat shape (AC-17.14)
- [ ] 6.2 Add at least one hierarchical Tier C reference IR with the full file set pinned byte-exactly per file plus per-sheet and aggregate score JSON, and confirm every existing flat golden is unchanged (AC-17.12)
- [ ] 6.3 Update the schematic-drafting reference page with the hierarchy section (partition rule, top-sheet derivation, mode decision) and document `hierarchyThreshold` and `hints.hierarchy` in the config reference
- [ ] 6.4 Settle the default `hierarchyThreshold` against corpus data and record the decision in docs/DECISIONS.md

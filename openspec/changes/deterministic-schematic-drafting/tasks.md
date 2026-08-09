# deterministic-schematic-drafting: Tasks

> Ordering note: groups 1-4 are the checker phase and land against the current model-authored flow, stopping unreadable sheets immediately. Groups 5-11 are the engine phase; the stage-4 switch (group 11) lands last so the model-authored path stays intact until one reviewed change. External dependency: `turn-budget-continue-and-loop-efficiency` must archive first (it owns the base "Content-aware stage completion" text).

## 1. Legibility geometry primitives

- [x] 1.1 Extend `src/kicad/sexp.ts` with the read-only accessors the checker needs: sheet graphic items (`rectangle`, `text`, `polyline`, `circle`, `arc`), wire segments with endpoints, label items with position and rotation, `(paper …)`, and `(title_block …)` fields
- [x] 1.2 Implement symbol body bounding boxes in `src/kicad/legibility.ts`: union the `lib_symbols` graphic items of the instance's library entry, exclude pin name/number text, transform by `at`/rotation/mirror reusing the existing pin transform
- [x] 1.3 Implement conservative stroke-font text extents (0.6 × height advance ratio per C3) for property text, labels, and free text; unit tests pinning the ratio and the resulting boxes
- [x] 1.4 Implement the standard paper-size table, frame border, and reserved title-block rectangle; usable-area computation; unknown-size returns skipped rather than passing

## 2. Check families

- [x] 2.1 Group model: extract group rectangles and captions, resolve symbol membership by geometric containment (innermost wins), exempt power-port symbols; families `ungrouped-symbol`, `unlabeled-group`, `group-overlap`; caption validation against SUBSYSTEMS.md and BOM.md with loud skip when absent
- [x] 2.2 Collision families: `symbol-overlap`, `text-collision`, `wire-through-symbol`
- [x] 2.3 Grid and frame families: `off-grid` (symbol origins, wire endpoints, label positions) reported first per C9; `out-of-frame`
- [x] 2.4 Advisory families: `low-utilization`, `crowding`, `label-orientation`, `cross-group-wire`; `empty-title-block` over title, revision, and date
- [x] 2.5 Finding shape `{kind, severity, sheet, at, refs, detail}` with the concrete fix in `detail`; unordered-pair dedup; per-family per-sheet cap with an explicit suppressed count
- [x] 2.6 Walk the full sheet hierarchy from the root schematic; attribute every finding to its sheet; page checks use each sheet's own paper value
- [x] 2.7 Add the optional `legibility` config block (per-family severity including `off`, thresholds, caps) with documented defaults; document it in the generated `.copperhead/README.md`

## 3. Checker wiring (agent, pipeline, check)

- [x] 3.1 Add the `check_legibility` tool to `src/agent/tools.ts`, shaped like `verify_symbols`; graceful message when no schematic is configured
- [x] 3.2 Feed outstanding error-severity findings into the sync-obligations ledger so `finish` refuses while the sheet is illegible; edits and drafts re-open the obligation, a clean run clears it
- [x] 3.3 Add the drafting-standard block and the reconcile instruction to the stage-4 prompt in `src/commands/create.ts`
- [x] 3.4 Extend the schematic stage completion contract with zero error-severity findings; unmet contract halts with finding counts and a resume hint; advisories recorded in the run summary
- [x] 3.5 Run the checker in `src/commands/check.ts` (findings grouped by severity, exit code unaffected); add the `legibility` object to `check --json` (score field null until group 8 lands)

## 4. Checker fixtures and tests

- [x] 4.1 Well-drafted fixture schematic reporting zero findings; illegible variant exercising every family; hierarchical fixture with a defect only on a sub-sheet
- [x] 4.2 Tests: per-family detection, conservative-extent behavior, pair dedup, cap with stated suppressed count, severity override and `off`, unknown paper skip, power-symbol group exemption
- [x] 4.3 Tests: checker leaves file bytes unchanged, makes no subprocess or network call; `check` exit code unaffected; `--json` contract; stage-4 contract fails on errors, passes with advisories; `finish` lists outstanding findings

## 5. Deterministic emitter (src/kicad/emit.ts)

- [x] 5.1 Canonical text emission: fixed section order, fixed indentation, KiCad number formatting, header template with the pinned format version
- [x] 5.2 UUIDv5 derivation from semantic paths (project namespace; `sheet/<ref>`, `sheet/<ref>/pin/<n>`, `wire/<net>/<i>`, labels, junctions) and canonical element sort orders
- [x] 5.3 Hermetic symbol vendoring: copy each used symbol's `.kicad_sym` source into the committed project cache on first use; drafts read the vendored copy; explicit refresh path with reviewable diff; `verify_symbols` still compares against installed libs
- [x] 5.4 Verbatim `lib_symbols` embedding: copy the `(symbol …)` block byte-for-byte from the vendored source with only the lib_id rename
- [x] 5.5 Emit symbols (properties, per-pin uuids, per-symbol `(instances …)`), wires, junctions, labels, power symbols, `(no_connect …)` markers, `PWR_FLAG`s, group rectangles and captions, title block
- [x] 5.6 Golden tests: byte-exact diff against a KiCad-saved reference; `kicad-cli` loads the output and ERC runs; byte-identical re-emission
- [x] 5.7 Cross-check tests: parse emitter output with the read-only parser; pin positions and inferred nets match the input model

## 6. Netlist-intent IR (src/kicad/draft/ir.ts)

- [x] 6.1 Versioned IR schema (parts, connections, groups, no-connects, net kinds, hints) with TypeScript types; documented in docs/reference
- [x] 6.2 Validation: lib_id resolution (reuse symlib), pin existence, minimum net endpoints, exactly-one-group per non-power part against SUBSYSTEMS.md, no-connect consistency, BOM.md cross-check (refdes present, value matching), unsupported-version refusal
- [x] 6.2a Refuse a part resolving to a power-port symbol, naming `nets`/`kind` as the fix: the engine supplies power symbols per pin of every power-class net, so a model-authored one was accepted and then silently discarded by the placement passes (#212)
- [x] 6.3 Validation failures as a numbered finding list in the `verify_symbols` shape; a failed draft never touches the schematic on disk
- [x] 6.4 Unit tests: one failing fixture per validation rule, plus a clean fixture

## 7. Drafting engine (src/kicad/draft/)

- [x] 7.1 Reductions: deterministic power-class recognition (pin electrical types with IR override, resolved classes in the draft report), stripping to per-pin power symbols (rails up, grounds down), decoupling-cap classification with the deterministic ownership tie-break, connector edge assignment, group partition
- [x] 7.1a Gate-resolvability synthesis: `(no_connect …)` markers for declared no-connects, one `PWR_FLAG` per undriven power-class net at a deterministic location
- [x] 7.2 Group layout: flow ordering from the directed pin-type graph with SUBSYSTEMS.md order as tie-break, group box sizing from summed extents including power symbols, decoupling rows, and text slots (reuse the checker's C2 math), captioned rectangles per the standard
- [x] 7.3 In-group placement: longest-path layering, barycenter ordering, integer 1.27mm grid throughout, refdes/value text slots that never collide
- [x] 7.4 Wiring policy: local nets up to four endpoints within one group and the distance budget wired orthogonally in reserved inter-column channels (never crossing a body box), junction synthesis, net labels (horizontal-preferred) for everything else
- [x] 7.5 Idiom micro-templates: pull-up/pull-down stubs, crystal flanking, connector edge placement
- [x] 7.5a Alignment and balance pass: shared column axes, uniform sibling gaps, collinear passive chains (zero-bend wires between aligned pins), mirror-symmetric pairs, centered group contents, page-balance distribution; preserves grid, connectivity, and gating invariants
- [x] 7.6 Determinism audit: no `Date`, no `Math.random`, no filesystem-order or locale dependence; property test drafting the same IR twice yields identical bytes
- [x] 7.7 Engine acceptance: every Tier C reference IR drafts with zero error-severity legibility findings and clean ERC

## 8. Scoring tool (src/kicad/score.ts)

- [x] 8.1 Metrics: wire crossings, bends, total wire length, alignment consistency, page utilization, label-to-wire ratio, group cohesion, flow-direction violations, axis-alignment ratio, spacing uniformity, straight-wire ratio, label alignment, whitespace balance, pair symmetry, checker finding counts; full pre-rounding precision
- [x] 8.2 Weighted composite with weights from the `legibility` config block and the error-severity cap below the Tier A floor
- [x] 8.3 Always-on per-metric breakdown (raw value, weight, contribution, applied cap) in human and JSON output; populate `check --json`'s `legibility.score`
- [x] 8.4 Unit tests per metric against constructed fixtures with hand-computed expected values

## 9. Golden benchmark corpus (test/fixtures/golden/)

- [x] 9.1 Tier A: known-good hand-drawn sheets (KiCad demo projects with compatible licenses plus the repo fixture), each with a provenance note; pin zero error findings and the score floor
- [x] 9.2 Tier B: the #136 run's sheet plus one synthetic fixture per gating family; pin exact finding lists and the score ceiling
- [x] 9.3 Tier C: reference IRs (small MCU board, sensor node, power-only board); pin byte-exact drafted output and full score JSON
- [x] 9.4 `--update-goldens` regeneration in the test harness; suite fails on mismatch without it and never writes goldens implicitly
- [x] 9.5 CI wiring: run all tiers, render each to SVG as a CI artifact, fail on any pin violation

## 10. CLI and agent tools

- [x] 10.1 `copperhead draft schematic`: IR through engine and emitter, draft report, non-zero exit with findings on validation failure; LLM-free and network-free
- [x] 10.2 `copperhead score schematic`: score JSON, exit code independent of the composite; LLM-free and network-free
- [x] 10.3 `draft_schematic` tool: validate + draft + report with embedded checker findings and score, updating the legibility ledger obligation; spec-gated; failed draft leaves the schematic untouched
- [x] 10.4 `score_schematic` tool: composite + breakdown + cap, graceful no-schematic path
- [x] 10.5 Drafting-mode guard: refuse `edit_file`/`write_file` against an engine-drafted schematic, naming `draft_schematic`; `copperhead do` on human-drawn sheets untouched
- [x] 10.6 Command and tool tests covering the cli-surface and agent-core delta scenarios

## 11. Stage-4 restructure (src/commands/create.ts)

- [x] 11.1 Rewrite the schematic stage instruction: author intent, never coordinates; repair through the IR; run `check_legibility` and `score_schematic` before finishing
- [x] 11.2 Extend the completion contract: drafted sheet matches a re-draft of the current IR (staleness check), score recorded in the run summary; keep symbol/drift/ERC/legibility conditions
- [x] 11.3 Persist `schematic.intent.json` alongside the schematic and commit both together
- [x] 11.4 Integration test: scripted stage-4 run in drafting mode completes, records the score, and refuses geometry edits
- [x] 11.5 Rollback check: reverting the stage-4 wiring restores the model-authored flow with the checker still gating and `draft`/`score` functional standalone

## 12. Docs and spec

- [x] 12.1 Keep docs/reference/schematic-legibility.md in sync with implementation; write docs/reference/schematic-drafting.md explaining the engine's inner workings and rules
- [x] 12.2 Document the IR schema, `draft`/`score` commands, and the golden corpus workflow (including `--update-goldens`)
- [x] 12.3 Update .copperhead/README.md scaffold text for the `legibility` config block including score weights
- [ ] 12.4 Merge delta specs into SPEC.md on archive; the AC-16.x criteria (AC-16.1 through AC-16.32, tagged on the delta-spec scenarios) join SPEC.md's acceptance-criteria table
- [ ] 12.5 Close #136 and #159 when archived; note the elkjs escape hatch and template-corpus successor in ROADMAP.md

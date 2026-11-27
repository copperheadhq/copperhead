# add-pcb-layout-framework: Tasks

> Ordering follows RFC 11 Appendix B. Phase 0 precedes every wrapper (§3.8: an ADR per layer before code). The checkpoint after Phase 2 is a real stop: publish the B1 report and decide whether Phase 3 proceeds now. Each phase's exit criterion is the last task of its group.

## 1. Phase 0: teardowns, ADRs, fixtures

- [x] 1.1 Teardown PCBWorld: corpus format, splits, metric implementations, license and redistribution terms; ADR recording what is adopted verbatim and how the subset is referenced (§4.2, Appendix C.2 item 7)
- [x] 1.2 Teardown kicad-tools: parsers, DRC, fab profiles, placers, A* router; per-module wrap-vs-vendor ADR (Appendix C.2 item 8); pin the upstream commit
- [x] 1.3 ADRs for the remaining Appendix C.2 defaults: KiCad 10 pinned, TypeScript geometry with the polygon kernel chosen, JSON Schema contracts, critical-DRC definition, `jlcpcb-2layer` profile, bench in-repo for now; each ADR names the §4.1 neighbour evaluated
- [x] 1.4 License review for FreeRouting packaging (out of process, user-installed jar) and pyplacer; record in the ADR
- [x] 1.5 Ten golden microboards with seeded violations (overlap, bounds, fixed connector, decoupling, keepout, open, short, clearance, completion, congestion) under `bench/golden/`, each with its expected diagnostic codes; closes #14's zoo for layout
- [x] 1.6 Exit: golden cases run through `kicad-cli pcb drc` in CI; every ADR accepted

## 2. Phase 1: IR, KiCad adapter, verification

- [x] 2.1 `src/pcb/ir/`: `PcbDesign`, `BoardDefinition`, `ComponentInstance`, `PadDefinition`, `NetDefinition`, `PlacementState`, `RoutingState`, `CopperZone`; integer-nanometre geometry module behind the chosen kernel; canonical serialization and content hash; schema version and migration hook; `status.ts` with the eight statuses
- [x] 2.2 KiCad import: board-side read-only reader in `src/kicad/sexp.ts` (footprints, pads, nets, outline, copper, zones, netclasses, `.kicad_dru`), closing #8; stable ids from KiCad UUIDs; `referenceMap`
- [x] 2.3 KiCad export: apply a candidate to an immutable copy by text surgery (footprint `(at …)`, appended copper with UUIDv5 ids, zones untouched); zone refill through the pinned tool; shared number and uuid helpers moved to `emit.ts`
- [x] 2.4 `BoardSnapshot` and the isolated run directory; a test proving an engine wrapper writing to its input cannot touch the source (AC-17.2); stale-hash rejection
- [x] 2.5 `src/pcb/verify/`: geometry checker, connectivity checker, KiCad DRC adapter over `report.ts`, normalized `Diagnostic`, `checker_disagreement` events; kicad-tools DRC adapter as a `process`-mode checker (kicad-happy deferred: not yet torn down, no adapter in Phase 1)
- [x] 2.6 Fabrication profile `jlcpcb-2layer` vendored as JSON with the critical-DRC family list; pre-flight input checks (§10.6) returning `REFUSE`
- [x] 2.7 Tests: round trip on the reference boards and the KiCad demo projects retains geometry and connectivity (AC-17.1); every golden seeded violation detected with its stable code (AC-17.6); canonical hash stability
- [x] 2.8 Exit: round-trip fixtures pass; seeded violations detected; import-direction test in place (D1)

## 3. Phase 2: routing harness

- [x] 3.1 `src/pcb/engines/`: `RouterPlugin`, `PlacerPlugin`, `CheckerPlugin` contracts and manifests; JSON Schema generation; registry and discovery; manifest validation (AC-17.3)
- [x] 3.2 Runner: `single`, `race`, `staged`, `ensemble`; capability negotiation returning `UNSUPPORTED` (AC-17.4); license and network policy; out-of-process isolation with provenance on every invocation; engine-second accounting
- [x] 3.3 `router-freerouting`: DSN emission and SES import re-landed from PR #253's bridge behind the contract (KiCad's exporter as the dialect, resolution-unit SES coordinates, board copper layer names carried through); jar and JRE discovery; named failures including `java-too-old`
- [x] 3.4 `router-kicad-tools-astar` wrapper; `router-reference` grid router marked `harnessOnly`
- [x] 3.5 `src/pcb/verify/scoring.ts`: PCBWorld's eight routing metrics verbatim plus the §11.2 additions; the two-layer return-path checker and metrics (pour fragments and largest share, bottom-layer signal length, pour crossings, stitching); lexicographic gates and Pareto frontier; `default-low-speed-2-layer` profile weighting return-path metrics ahead of wirelength
- [x] 3.5a Default staged routing plan (§9.5): power and ground first at physics-compiler or user widths with pours preserved, critical nets next, bulk by race; layer-preference constraints mapped to Freerouting's layer settings
- [x] 3.6 `bench/`: runner over golden microboards (grow to 40) and the 20-board PCBWorld qualification subset; JSON and HTML reports with the §13.4 record; `copperbench run|compare|report`
- [x] 3.7 `copperhead pcb import|route|verify|score`; `check` module-graph guard extended to `src/pcb/engines/` and `src/pcb/agent/` (AC-17.5)
- [x] 3.8 Exit: B0 report (byte-stable harness, AC-17.12) and B1 report (selection regret zero, invalid-over-valid zero, overhead measured) published under `bench/reports/`

## 4. Checkpoint

- [x] 4.1 Publish the B1 evidence and decide, in a recorded ADR, whether Phase 3 proceeds now or the routing harness alone ships in `create` stage 5 (populate, DRC, wrapped routing with evidence, model moves parts); reconcile with the validation plan — B1 published (`bench/reports/B1-2026-09-06.md`); ADR 0009 proposes routing-first then Phase 3, accepted 2026-09-06: routing ships first (group 4b), then Phase 3

## 4b. Phase 2b: routing in `create` and `check` (ADR 0009)

- [x] 4b.1 Completion contract for layout evidence: `outcome.status ∈ {PASS, PARTIAL}`, `snapshot.hash === hashDesign(import(board))`, evidence markers in `docs/LAYOUT.md` naming the run directory, selected engine, and metrics
- [x] 4b.2 `create` stage 5: after population, verify the board (pre-flight and placement gates), route it through `routeBoard` with the configured engines and budget, apply the selected candidate, render the evidence summary ("Board as routed" block with the diagnostics and metrics), and hand the model only the placed-parts moves on a gate failure; no model call routes
- [x] 4b.3 `check`: when `docs/LAYOUT.md` carries the evidence markers, run pre-flight, geometry, connectivity, return path, and KiCad DRC on the committed board and print the layout track; no engine, no model, no network (AC-17.5 guard extended)
- [x] 4b.4 Docs (`create`, `check`, `LAYOUT.md`), tests for the contract and both surfaces; Phase 4's `check` task (7.x) reduced to the intent checkers

## 5. Phase 3: placement harness

- [x] 5.1 `placer-fixed`, `placer-pyplacer`, `placer-kicad-tools-physics`, `placer-kicad-tools-evolutionary` wrappers; `placer-reference` marked `harnessOnly`; `board.ts`'s shelf pack retired into it (the reference placer packs over the IR; `board.ts` keeps its own copy for population, which runs before an IR exists)
- [x] 5.2 `placer-layout-reuse`: anchor transforms over approved module placements (plus `placer-attach` for `relative.attached`; both run as stage 3 with their anchors and targets locked)
- [x] 5.2b Reference layout retrieval, local sources (in `src/pcb/intent/references.ts`; the datasheet source and online search need a model and land in Phase 4): `ReferenceSource` interface, the `design` source over KiCad demos, PCBench, reference boards, and `pcb.referenceDesigns` (import, cut to block, role mapping), the `teardown` source over RFC 1 outputs, similarity scoring, the `.copperhead/layout-refs/` cache and index, the license policy with `HOLD` and approval, application as attachment and group constraints consumed by `placer-layout-reuse`
- [x] 5.2a Deterministic block derivation from SUBSYSTEMS.md and the schematic intent's `group` field (anchor, signal-flow region, spread budget); `placer-anchors` and `placer-attach` rule stages; the default staged placement plan (§8.5) with stages 1 to 3 locked before the wrapped placer runs (blocks live in `src/pcb/intent/blocks.ts` so the engines may import them; `placer-attach` is a no-op stage until the intent checker's `relative.attached` lands in Phase 4)
- [x] 5.3 Placement verification: hard placement gates (§10.4); routability probe through the fixed reference routing configuration; placement metrics (§11.1) — intent-derived metrics (`intent_compliance`, `critical_attachment_nm`, block spread) land with the intent checker in Phase 4
- [x] 5.4 30 placement cases in the bench; `copperhead pcb place`; HPWL-vs-completion evidence (B2: r = −0.65 across the 20 real boards, 0.03 on the microboards)
- [x] 5.5 Exit: B2 report and the §8.3 decision recorded (`bench/reports/B2-2026-09-06.md`: no copperhead placer at B2; re-evaluate on intent at B3; a legalization repair action is the first Phase 5 catalogue entry)

## 6. Phase 4: intent

- [x] 6.1 Layout constraint classes in `src/memory/constraints.ts` and `record_constraint` (additive fields); registry documentation in the generated `.copperhead/README.md`
- [x] 6.2 ECAD ingestion on import (`source: ecad_rules`, re-derived every import, `HOLD` on contradiction)
- [x] 6.3 Intent language (§7.3) parser; intent compiler with block and role identification through the fact base, provenance, approval, and `HOLD`; refdes-to-id resolution (`src/pcb/agent/intent/compiler.ts`; the fact base is BOM.md plus `.copperhead/datasheets/*.txt|md`; `pcb infer-intent --model` runs the two model steps, the `pcb_infer_intent` tool is deterministic because the agent is the model)
- [x] 6.4 Physics compiler (IPC-2221 generic formula vendored as `vendor/ipc/current-width.json`; the IPC-2152 tables are not redistributable): IPC-2152-compatible current-width where data exists, advisory otherwise; impedance `HOLD` without stackup; stackup class accepted but pinned to one two-layer profile
- [ ] 6.4a (blocked: needs the `fetch_datasheet` / `web_search` clients from `add-part-research-tools`, not on this branch) Reference layout retrieval, network sources: the `datasheet` source (rule extraction from the cached datasheet, figure reading by one model call with capped confidence) and online design search through the part-research `web_search` client with shallow clones under `var/refs/`; `pcb_find_references` tool and `--refresh-references` / `--approve-reference` on `pcb layout`; transcript network log
- [x] 6.5 Intent checker for fixed, edge, orientation, attachment, group (spread against budget, region containment), region, separation, keepout (orientation is declared-but-not-evaluated, info severity); `pcb_infer_intent` tool; `copperhead pcb infer-intent`; layout track in `check` (AC-17.14)
- [x] 6.6 Track E (intent) and track F (refusal) in the bench with the curated microboard categories of §13.3 (`copperbench --kind verify`; 15 golden boards, 9 categories; 40 remains the target)
- [x] 6.7 Exit: B3 report published (`bench/reports/B3-2026-09-07.md`): tracks E and F 8/8 and 13/13; hard intent 6/10 after placement (60 %, below the 90 % claim: edge, keepout, and separation have no rule stage yet); no geometry-invalid candidate marked complete; §8.3 gate tripped on the sample, response proposed as rule stages in Phase 5, owner's decision

## 7. Phase 5: closed loop

- [x] 7.0 Rule stages the B3 evidence asks for before the repair loop: edge placement (stage 1: a part with `mechanical.edge` goes to that edge), keepout legalization (move a part the least distance out of a keepout), block separation (disjoint regions for separated blocks); re-take the B3 measure on the eight intent boards (re-taken: 9/9 hard intent constraints, 8/8 PASS; recorded in the B3 report)

- [x] 7.1 `src/pcb/agent/`: repair catalog with per-action cost estimates; engine-second and wall-clock budgets; planner over normalized diagnostics only; terminal statuses
- [x] 7.2 `pcb_layout` and `pcb_repair` tools (spec-gated); `edit_file` refusal of copper and zone edits on framework boards; `do` on a framework board through the repair loop (the tools are what `do` reaches for; the loop itself is `layoutBoard`)
- [x] 7.3 Evidence bundle under `.copperhead/runs/<ts>/layout/`; the evidence section in LAYOUT.md carries the per-subsystem table, the repair cycles, and the return-path metrics (`## Draft quality` stays the model's own words beside it); the fab release gate is not on this branch, so its freshness read is deferred with it
- [x] 7.4 `create` stage 5 switched to `pcb layout` (the closed loop runs on the populated board before the model's turn; the model moves parts; copperhead routes again when it finishes); completion contract on the bundle (AC-17.15, AC-17.16); `copperhead pcb layout`
- [x] 7.5 Track D (repair) and track C (end to end) in the bench (`copperbench --kind layout`; suites layout-microboards and repair-pcbench); reference-board set started: `bench/suites/reference-boards.json`, the ten PCBench boards that route clean at B1, kept as human calibration baselines
- [x] 7.6 README and docs site: the framework, the supported envelope page (§10.7), engine setup (`docs/src/content/docs/concepts/layout-framework.md`); ROADMAP non-goal reworded
- [x] 7.7 Exit: end to end runs unattended on supported boards and fails explicitly elsewhere; B4 reported as directional until 30 held-out boards (`bench/reports/B4-2026-09-07.md`: eight runs of each track, eleven loop defects found and fixed, repair cycles fixed no board yet)

## 8. Archive

- [ ] 8.1 On archive, merge the AC-17.x criteria and rewrite SPEC.md §3.8 "First-draft layout" around the evidence bundle (via /opsx:archive); mark RFC 11 Implemented

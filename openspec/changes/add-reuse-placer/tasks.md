> Status (2026-09-16, after the first implementation pass and the P0 bench run):
> the reuse path runs end to end offline — import, feasibility, subsystems,
> critical relationships, match, transfer, delta, plan, per-side phased packing
> through the vendored packer, variants, in-memory screening, critical routing,
> revision, and the `pcb reuse` command. `bench/reports/P0-2026-09-16/` measures
> 13 reconstruction cases to V5: 13/13 legal, but on 7 of them the plain
> reference copy wins, and every packed variant fails at V1 with unplaced parts
> on the four densest boards (peltier, hbridge, the 12/24 boost converter,
> komputer-klavier). P1 case artifacts exist without a report.
>
> Still open: the packer's islands and local search (5.3), the model loop beyond
> one planning round and the coordinate fallback (§8), the `pcb reuse` docs page
> (9.2), and verification (§10). Four tasks landed in a different shape than
> planned; each says so inline.

## 1. IR and pre-flight

- [x] 1.1 Importer and IR:
  - read `(path)`, `(sheetname)`/`(sheetfile)`, `(pinfunction)`/`(pintype)` into `symbolPath`, `sheet`, `pinFunction`, `pinType`, included in the canonical hash;
  - tests on `multichannel_mixer` and on a golden board whose hash stays unchanged.
- [ ] 1.2 Utilisation pre-flight:
  - `placementUtilisationWarn`/`Max` in the fabrication profiles (0.62/0.95);
  - `preflight.utilisation.*` with shortfall and growth;
  - tests for over-capacity, dense and pad extents.
  - *Landed differently:* `preflight.utilisation` exists in `verify/checkers/preflight.ts`, but the thresholds are the module constants `UTILISATION_WARN`/`UTILISATION_MAX`, not per-profile fields. Either move them onto `FabricationProfile` as planned or amend the plan.

## 2. Vendored geometry engine

- [x] 2.1 Vendor calculate-packing `a2d60ae` into `src/vendor/calculate-packing/`:
  - without tests, plumbing or visualisation;
  - `// @ts-nocheck` headers;
  - `VENDORED.md` (commit, MIT licence text, patch list);
  - add `@flatten-js/core`.
- [x] 2.2 P1: local `BaseSolver`, `computeDistanceBetweenBoxes`, `clamp`, `Bounds`, `Point`, `GraphicsObject`; imports rewritten; builds under `tsc`.
- [x] 2.3 P2 exact boundary containment, P3 weighted network distance, P4 no silent centre fallback, P5 failure detail.
- [x] 2.4 Typed facade `src/vendor/calculate-packing/facade.ts`, plus tests:
  - determinism;
  - concave notch;
  - weighted attraction;
  - first part with no legal position;
  - the import guard (vendor imports nothing from `src/`).

## 3. Subsystems and critical relationships

- [x] 3.1 `src/pcb/intent/subsystems.ts`:
  - intent (via `deriveBlocks`), sheet, nearest-anchor and Louvain partitions;
  - clean-up `none`/`support`/`all`;
  - merge of identical partitions;
  - tests on `complex_hierarchy` and a single-sheet board.
- [x] 3.2 `src/pcb/intent/critical.ts`:
  - class table, rule classification (pin function, net name, prefix, footprint, topology), relation records and registry constraints;
  - tests for decoupling, bootstrap, crystal, buck hot loop, output chain, aggressor/sensitive, low.
- [x] 3.3 Intent checker evaluators:
  - C2 hot loop, C3 isolation/channel/edge-distance/rf-edge, C5 chain, subsystem intrusion;
  - language keys in `language.ts`;
  - microboards `buck-hot-loop`, `noisy-sensitive`, `amp-output-chain`, `rf-edge` with seeded and fixed variants.

## 4. Reuse front end

- [x] 4.1 `src/pcb/engines/reuse/match.ts` (tiers 1–3, related mode) and `transfer.ts` (anchor fit, outline mapping, IoU); tests on the ecc83 pair.
  - *Note:* the ecc83 pair is exercised in `test/pcb-import.test.ts`; the match and transfer tests use their own fixtures.
- [x] 4.2 `delta.ts` statuses and delta set; `placer-reuse-copy` engine; tests.

## 5. Plans and phased packing

- [x] 5.1 `plan.ts`: plan type, validation rules, default plan (phases, region hints from flow and edges, orientations, groups); tests for validation and phase order.
- [x] 5.2 `compile.ts`:
  - phase to packer input per side (static parts, rotations, groups, class weights, attractors, inflation, obstacles, inset boundary);
  - packer output back to `PlacedComponent[]`;
  - tests.
- [ ] 5.3 `phases.ts`:
  - executor with two-level islands, the `loops` local search, `separation` repack, retries and flat fallback;
  - exact verification after each phase;
  - partial results naming unplaced parts;
  - phase log;
  - tests.
  - *Open:* the executor, retries, verification, partial results and the phase log are in; the two-level islands and the `loops` local search are not. P0 attributes the V1 unplaced-part failures on the dense boards to this.

## 6. Variants, ranking and engine

- [x] 6.1 `variants.ts`:
  - variant matrix and budget;
  - in-memory screen (`applyCandidate` + `importBoard` + `verifyDesign`);
  - merge by placement hash;
  - option selection with distinctness and trade-off lines.
- [x] 6.2 Tiers:
  - `ScoringProfile.tiers`, tier comparator in `rank()`, `src/pcb/verify/tiers.ts`, `engineering-placement-2-layer` profile;
  - tests: T4 decides over HPWL, existing profiles unchanged.
  - *Landed differently:* the tier metrics and comparator live in `verify/scoring.ts`; there is no separate `verify/tiers.ts`. Amend the plan or split the file.
- [x] 6.3 `placer-reuse-pack` engine returning the screened top candidates with variant keys; `probe.maxCandidates` in `placeBoard`.

## 7. Critical routing and revision

- [x] 7.1 `ProbeOptions.netNames`; `src/pcb/engines/critical-route.ts` (critical nets, `routeBoard({ netNames })`, return-path checker, metrics, copper discarded).
  - *Note:* the module is `src/pcb/engines/reuse/critical-route.ts`.
- [x] 7.2 `revise.ts` rules (rotate facing, swap equal footprints, release in-between parts) and the revision cycle from the affected phase; test with a seeded facing-away pair.

## 8. Model planner

The delta spec's **Model planner** requirement already mandates K plans, one
planning round plus two reassessment rounds, and datasheet facts with citations
in the input. What landed is one round with one plan and no datasheet facts, so
8.2 onwards is decomposition of a written requirement, not new scope.

**Measurement gate.** None of 8.2–8.7 can be accepted until
`add-placement-benchmark` 7.2 runs, and that needs a provider seam in
`src/bench/placement/run.ts`, which calls `defaultPlan` directly today — so no
model path is measurable at all. Land the seam first; each step below is then
one variable against a fixed bench, accepted or rejected on its own by the
RFC 14 §10 stage-merge criterion: no worse on the selected option's tier vector
(T1–T7) and on fidelity, and lower `model_share`, model output tokens or
fallback use.

- [x] 8.1 `src/pcb/agent/place/planner.ts`: the `reuse-plan/1` prompt, `RawPlan` → `PlacementPlan` mapping, plan validation, request/response records keyed by input hash, offline replay, `MODEL_CONFIDENCE_CAP`, and the rules plan as the fallback on every failure path.
- [ ] 8.2 Prompt content (spec §9.2):
  - pin names and numbers per part, not just the pad count;
  - `datasheetFacts` from `cachedDatasheets()` with their citations;
  - the default plan's screened tier vectors;
  - records carry the model id, template id and usage beside the input hash.
- [ ] 8.3 Partial credit (§9.3):
  - merge the model's regions, subsystems, orientations and phases element by element instead of all-or-nothing per field;
  - drop only the invalid entries rather than the whole plan;
  - one retry carrying the parse or validation error before the rules take over.
- [ ] 8.4 K plans (§9.3): ask for `{"plans":[…]}` in the `strict` and `engineer` stances, validate each, and feed every valid plan into the variant funnel so the in-memory screen chooses between them.
- [ ] 8.5 Reassessment rounds (§9.4):
  - send the screening table and the `criticalRouting` findings back for at most 2 rounds;
  - stop early when an option passes the placement gate with every part placed and has no findings;
  - `reuse.model.budget` when a §9.7 round, token or wall limit runs out.
- [ ] 8.6 `placer-reuse-plan` registered as an engine only with `--model`; scripted-provider tests (validation drops, capped confidence, replay equality, no provider constructed without `--model`).
  - *Decide first:* today the planner is a callback `pcb reuse` passes into `reuseRun`, so the model shapes every pack variant rather than being a candidate of its own. The spec says the engine is registered only with `--model`. Make spec and code agree before writing the tests.
- [ ] 8.7 `placer-reuse-coordinates` (§9.5, design decision 12):
  - runs only with `--model`, without `--no-fallback`, and only when no candidate passes the placement gate with every part placed;
  - asks for the stranded parts and the parts named in the gate findings, with their courtyard boxes per rotation and pad offsets, everything else an obstacle;
  - drops entries outside that set as `reuse.model.illegal-move`;
  - rule stages and `verifyDesign` after each answer, at most 3 rounds;
  - its own candidate with provenance `model-coordinates`;
  - measured against the P0 cases whose variants stranded parts.

## 9. Command and artifacts

- [x] 9.1 `copperhead pcb reuse` in `src/cli.ts` and `src/commands/pcb-reuse.ts`:
  - flags per spec;
  - `options.md`, `board.svg`/`board.png` per option, `variants/`, `--apply`/`--option`;
  - network-free test without `--model`.
- [ ] 9.2 Docs page for `pcb reuse` in `docs/src/content/docs/reference/cli.md`.

## 10. Verification

- [ ] 10.1 `npm run typecheck` and the full test suite pass (maxWorkers 4).
- [ ] 10.2 Live smoke:
  - `pcb reuse` on the ecc83 pair (with reference) and on three golden microboards (without), with KiCad and Freerouting;
  - options and renders inspected;
  - results feed `add-placement-benchmark`.

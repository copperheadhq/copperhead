# deterministic-schematic-drafting: Proposal

## Why

Stage 4 of `copperhead create` verifies only electrical facts: ERC checks the net graph, `verify_symbols` checks lib_id and pin fidelity. Nothing gates how the drawing reads, and every coordinate in the sheet is text the model authors token by token through `edit_file`, so placement is sampled, not computed. The two failure modes are documented on real runs: #136 shows an electrically clean sheet with refdes text over symbol bodies, content crammed into 40% of an A4 page, no flow direction, and an empty title block; #145 shows the cost, 5 of 40 turns emitting 89% of 170,920 output tokens in a 65-minute schematic stage, with every observed failure (provider error, budget exhaustion, stall) landing on an oversized geometry-emission turn.

This change fixes both at once: a deterministic legibility checker and drafting standard gate the output, and a rule-based drafting engine computes the geometry from a compact netlist-intent IR so the model never authors coordinates at all. Legibility becomes a property the engine guarantees by construction and the checker regression-tests, not a repair-loop objective. It supersedes the proposal-only `readable-schematic-drafting` change (PR #148): the checker is implemented here, together with the engine it gates. Tracked as #136 and #159.

## What Changes

- **A drafting standard for generated schematics** (unchanged from the absorbed proposal): captioned subsystem group boxes from SUBSYSTEMS.md, block-partitioned non-overlapping layout, left-to-right flow, rails up and grounds down, net labels rather than long wires between groups, paper sized to content, title block filled.
- **A deterministic read-only legibility checker** (`src/kicad/legibility.ts`) over the existing sexp parser, evaluating thirteen check families (nine error, four advisory) with coordinates and a concrete fix per finding; exposed as the `check_legibility` agent tool, fed into the sync-obligations ledger, reported by `check` as advisories, and gating stage-4 completion at error severity.
- **A netlist-intent IR** (`schematic.intent.json`): the compact, declarative input the model authors instead of geometry. Parts, connections, group assignments, declared no-connects, optional net-kind declarations and hints. Validation cross-checks parts against BOM.md up front. The model decides what to connect; it never writes a coordinate, and every defect the gates can raise is resolvable through the IR (no-connects are emitted as markers, undriven rails get a synthesized PWR_FLAG).
- **A rule-based deterministic drafting engine** (`src/kicad/draft/`): reductions first (power symbols per pin, decoupling rows beside their IC, connectors to edges, group partition), groups tiled left to right, in-group placement by longest-path layering and barycenter ordering in integer 1.27mm grid units, short local wires with L/Z escapes and junctions, net labels for everything else; local nets up to four endpoints inside a group may be wired, and wires run only in reserved channels so they never cross a symbol body. A final alignment pass makes the sheet pleasing to the eye: shared column axes, uniform sibling spacing, collinear passive chains with straight wires, mirror-symmetric pairs, centered group contents, and balanced page whitespace.
- **A deterministic KiCad emitter** (`src/kicad/emit.ts`): a string-template emitter, not a serializing parser, producing canonical `.kicad_sch` text with UUIDv5 identifiers from stable semantic paths, so identical IR yields byte-identical files. `lib_symbols` entries are copied verbatim from `.kicad_sym` sources vendored into a committed project cache on first use, so a KiCad library upgrade cannot change drafted output until the cache is deliberately refreshed.
- **A scoring tool** (`src/kicad/score.ts`): deterministic quantitative metrics (crossings, bends, wire length, alignment, utilization, label ratio, group cohesion, flow violations, plus aesthetic metrics: axis alignment, spacing uniformity, straight-wire ratio, label alignment, whitespace balance, pair symmetry) rolled into a weighted 0-100 composite with the breakdown always reported; error-severity findings cap the score.
- **A golden benchmark corpus** (`test/fixtures/golden/`): Tier A known-good sheets pinned to zero errors and a score floor; Tier B known-bad sheets pinned to exact finding lists and a score ceiling; Tier C engine outputs byte-diffed and score-pinned in CI.
- **New CLI surface**: `copperhead draft schematic` and `copperhead score schematic`, both LLM-free and network-free; `check` gains legibility advisories and a `legibility` object (findings, counts, skipped, disabled, score) in `--json`.
- **Stage-4 restructure**: intent authoring (model) plus deterministic drafting (engine), with ERC, `check_legibility`, and the scorer gating the combined output; geometry edits against an engine-drafted sheet are refused in favor of IR revision.
- **Binary acceptance criteria**: the change's scenarios carry the AC-16.x family (AC-16.1 through AC-16.32), tagged in the delta specs and merged into SPEC.md on archive.

## Capabilities

### New Capabilities

- `schematic-legibility`: the drafting standard, the check families and severities, threshold and configuration semantics, finding format, and hierarchy walking.
- `schematic-drafting-engine`: the netlist-intent IR schema and validation, reduction rules, placement rules, wiring and labeling policy, determinism guarantees, and failure semantics.
- `schematic-emission`: the deterministic emitter contract: canonical formatting, stable UUID derivation, verbatim lib_symbols embedding, pinned format version, byte-identical regeneration.
- `schematic-scoring`: the metric set, composite and weighting semantics, the error-finding cap, the golden corpus tiers and pinned expectations, and where scores surface.

### Modified Capabilities

- `create-pipeline`: the schematic stage states the drafting standard, splits into intent authoring and deterministic drafting, and its completion contract gains legibility, draft-staleness, and score-recording conditions.
- `agent-core`: the tool list gains `check_legibility`, `draft_schematic`, and `score_schematic`; legibility findings feed the sync-obligations ledger; geometry edits are refused in drafting mode.
- `cli-surface`: `check` reports legibility advisories without affecting the exit code; `--json` gains the `legibility` object including `score`; new `draft` and `score` commands.

## Impact

- **Code**: new `src/kicad/legibility.ts`, `src/kicad/draft/`, `src/kicad/emit.ts`, `src/kicad/score.ts`; read-only accessor extensions in `src/kicad/sexp.ts`; new tools in `src/agent/tools.ts`; new `draft` and `score` commands; stage-4 prompt and completion contract in `src/commands/create.ts`; `check` wiring in `src/commands/check.ts`.
- **Config**: one optional `legibility` block in `.copperhead/config.json` covering checker thresholds, per-family severity (with `off`), and score weights, with documented defaults.
- **Fixtures**: the three-tier golden corpus, reference IRs with pinned outputs and scores, a well-drafted fixture and an illegible variant per check family, and a `--update-goldens` regeneration path. The vendored symbol cache is committed alongside the schematic as as-built fact.
- **Docs**: the schematic-legibility reference page (already on this branch) plus a new schematic-drafting reference page explaining the engine's inner workings and rules.
- **Invariants**: the sexp parser still never serializes; the emitter is a separate template module cross-checked by the read-only parser. Spec-gating and verification-gating are untouched. `check` stays LLM-free and network-free.
- **Ordering**: the create-pipeline delta modifies the "Content-aware stage completion" requirement, whose base text currently exists only in the active `turn-budget-continue-and-loop-efficiency` change; that change must archive first. The agent-core legibility obligation should be shaped together with the `symbol-verification` obligation kind proposed in #133. The superseded `readable-schematic-drafting` change directory is removed and PR #148 closed in favor of this change.
- **Out of scope**: PCB layout drafting (#141), template micro-layout corpora beyond built-in idiom rules, and any elkjs dependency (documented as the v2 escape hatch).

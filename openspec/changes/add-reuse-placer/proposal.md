## Why

Copperhead has no placer that works on real boards. In B2, pyplacer's candidates overlapped on 17 of 17 PCBench boards, kicad-tools' force-directed placer left the outline on every board it finished, and the designers' placements won all 20. RFC 11's exception to "Wrap before Build" is therefore taken.

The draft placement standard RFC 14 (`../wt-rfc14-placement/rfc/rfc14.md`) specifies the placer to build instead:
- **Engineering order:** it places the way a hardware engineer does, from mechanical parts to regions, main ICs, datasheet-critical support parts, current loops, separation and the rest.
- **Model plans, engine moves:** a model plans the structure and a deterministic packer computes every coordinate.
- **Routing inside the loop:** critical nets are routed, and the plan is revised on failure.

This change implements v0 of that standard, so RFC 15's benchmark (`add-placement-benchmark`) has a placer to measure.

## What Changes

- **IR additions:** each component's schematic symbol path and hierarchical sheet, and each pad's pin function and pin type, imported from the board file.
- **Feasibility pre-flight:** utilisation per board side against profile thresholds (warning 0.62, refusal 0.95, measured on 46 designer boards). An over-capacity board is refused before any engine runs, with the shortfall stated.
- **Subsystems:** partitions from intent, hierarchical sheets, nearest anchor IC, and Louvain clustering, with clean-up variants (none, support, all). Each partition is recorded as a functional group constraint, and an intrusion evaluator is added.
- **Critical relationships:** rules that classify connections by physical importance, each class carrying a placement phase, a packing weight, a check and a ranking tier. The classes are mechanical, rf-keepout, supply-decoupling, bootstrap, config, crystal, hot-loop, output-chain, aggressor, sensitive, channel, thermal, signal and low.
- **Reuse:** part matching (symbol path, reference designator, net signature), transfer of the reference placement into the target frame (fixed anchors or outline mapping), and the delta table.
- **Placement plans:** a plan type, its validation, and a deterministic default plan in engineering phase order (mechanical, regions, anchors, support, loops, separation, remaining).
- **Phased packing on a vendored packer:** tscircuit calculate-packing at `a2d60ae` (MIT) under `src/vendor/calculate-packing/`, with five patches:
  - P1: local helpers;
  - P2: exact outline containment;
  - P3: weighted network distance;
  - P4: no silent centre fallback;
  - P5: failure detail.

  The compiler adds class weights, a pull toward reference positions, region and pin attractors, repulsion by courtyard inflation, two-level subsystem islands, and retries.
- **Variants and options:** partition × clean-up × island split × packing strategy, screened in memory, then materialised, routed on critical nets, and probed for the top candidates. Up to three distinct options are presented.
- **Tiered ranking:** a `tiers` field on scoring profiles and an `engineering-placement-2-layer` profile. `rank()` compares tier by tier within tolerances, keeps the weighted score as the final tie-break, and keeps Pareto membership.
- **Critical routing and revision:** critical nets routed with `routeBoard({ netNames })` and return paths checked, then deterministic revision (rotate facing parts, repack parts in between) and model reassessment.
- **Model planner:** `placer-reuse-plan` makes tool-less, schema-validated plan rounds through the provider abstraction, with capped confidence, replay by input hash, and budgets.
- **Coordinate fallback:** `placer-reuse-coordinates` asks the model for positions only for the parts the packer stranded and those named in the gate findings, inside the free space, with the rule stages and `verifyDesign` as the gate and at most 3 rounds. Candidates carry provenance `model-coordinates`.
- **Placement intent checks:** current loops (C2), isolation, channel and RF (C3), ordered chains (C5), and subsystem intrusion, plus the intent language keys for them.
- **Engines and command:** `placer-reuse-copy`, `placer-reuse-pack` and `placer-reuse-plan`, and the `copperhead pcb reuse` command. `--reference` is optional; without it the same pipeline runs with no copy. The run writes options, renders and a phase log.
- **Not in this change:**
  - voltage clearance (C1), and thermal and matched pairs (C4);
  - stages 1 to 7 of RFC 14 §14: repair search, datasheet extraction, optimal matching, region floorplanning, packer upgrades, orientation pass, refinement;
  - images to the model;
  - side flips.

## Capabilities

### New Capabilities
- `pcb-reuse-placer`: the reuse placer, covering feasibility, subsystems, matching, transfer and the delta table; plans and the default plan; phased packing on the vendored packer; variants, screening and options; critical routing and revision; the model planner; the `pcb reuse` command.
- `pcb-placement-intent`: the critical relationship classes and their rules, and the placement intent evaluators for current loops, isolation, channels, RF edge and clearance, ordered chains and subsystem intrusion, with their intent language keys.

### Modified Capabilities
- `pcb-ir`: symbol path, sheet, pin function and pin type imported and hashed.
- `pcb-verification`: the utilisation pre-flight check.
- `pcb-scoring`: tiered ranking in scoring profiles and the `engineering-placement-2-layer` profile; `routabilityProbe` accepting a net subset.
- `cli-surface`: the `copperhead pcb reuse` command.

## Impact

- **New code:** `src/pcb/engines/reuse/`, `src/pcb/engines/placers/reuse-copy/`, `src/pcb/engines/placers/reuse-pack/`, `src/pcb/agent/place/`, `src/pcb/intent/critical.ts`, `src/pcb/intent/subsystems.ts`, `src/vendor/calculate-packing/`, `src/commands/pcb-reuse.ts`.
- **Changed code:** `src/pcb/ir/types.ts`, `src/pcb/ir/kicad/import.ts`, `src/pcb/verify/checkers/preflight.ts`, `src/pcb/verify/checkers/intent.ts`, `src/pcb/verify/scoring.ts`, `src/pcb/verify/profiles/`, `src/pcb/engines/probe.ts`, `src/pcb/intent/language.ts`, `src/cli.ts`.
- **New dependency:** `@flatten-js/core` (MIT), used by the vendored packer's outline construction.
- **Depends on** `add-pcb-layout-framework` and `add-multilayer-layout` (unarchived). Existing commands keep their behaviour: `pcb place` stays LLM-free, and existing scoring profiles rank as before.
- **Evidence:** research notes `copperhead-placer-research-2026-09-16.md`, `copperhead-llm-placement-engine-spec-v0.2.md` (CH-PLACE-0001), and RFC 14 in `../wt-rfc14-placement`.

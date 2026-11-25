## Context

The draft RFC 14 (`../wt-rfc14-placement/rfc/rfc14.md`) specifies the reuse placer, and CH-PLACE-0001 v0.2 (`copperhead-llm-placement-engine-spec-v0.2.md`) carries its detailed design. This change is v0.

The facts that shape it:

- **Existing placement path.** `placeBoard` (`src/pcb/engines/place.ts`) imports the board and builds the constraint registry. It runs the rule stages, runs placers through `runPlacement`, then legalises, materialises (KiCad zone refill and DRC), verifies, probes and ranks every candidate. A placer is a `PlacerPlugin` returning `PlacedComponent[]`, and `applyCandidate` writes positions into the source text.
- **Engine contracts and model isolation.** Engines never import `src/pcb/agent/` (`test/pcb-imports.test.ts`). Model calls use the provider abstraction; on this machine that is `claude-code:<id>` through the saved login.
- **The packer to vendor.** tscircuit calculate-packing at `a2d60ae` is 5,090 lines outside tests, plumbing and visualisation. Its runtime imports come from `@tscircuit/math-utils` (`computeDistanceBetweenBoxes`, `clamp`, types), `@tscircuit/solver-utils` (`BaseSolver`, which the repo also carries locally), `graphics-debug` (types only) and `@flatten-js/core` (outline booleans).
  - It is deterministic.
  - It reduces courtyards to boxes.
  - Its weights only filter weak connections.
  - Its outline containment tests corners and pad centres only.
  - It places the first part at the centre even when that is illegal.
- **The measurements behind the thresholds and sources:**
  - designer boards leave about half of each side uncovered (median 48 %, p90 62 %, max 93 %);
  - sheet partitions and nearest-anchor partitions are equally compact on designer boards (cohesion 0.55, purity 0.78 and 0.74), and Louvain is less pure (0.58).
- **Tooling on the reference machine:** KiCad 10.0.4 (`kicad-cli pcb export svg`), Freerouting 2.4.1 (deterministic, no seed), ImageMagick `convert`, and chromium.

## Goals / Non-Goals

**Goals:**
- A working reuse placer that places boards of at most 50 parts, with and without a reference, in the RFC 14 engineering order, deterministically without a model and replayably with one.
- Every candidate passes the existing gates, and ranking follows the engineering tiers.
- Enough fidelity to RFC 14 that the benchmark (`add-placement-benchmark`) measures the design, not a shortcut.

**Non-Goals:**
- C1 voltage clearance and C4 thermal/matched checks, and the RFC 14 §14 stages 1–7.
- Images to the model, side flips, and several references.
- Four-layer tuning; the placer is layer-agnostic but measured on two layers.

## Decisions

1. **Vendor the packer with `// @ts-nocheck` headers and local helpers.**
   - The alternative, rewriting 5,000 lines to pass `noUncheckedIndexedAccess`, would change the code we mean to keep close to upstream and hide the patch diff.
   - The vendored directory carries `VENDORED.md` and a `README` listing patches P1–P5, and exports a small typed facade (`pack.ts`) that the rest of copperhead calls.
   - `@flatten-js/core` is added as a dependency. Porting outline construction to `polygon-clipping` was rejected for v0 because it changes upstream behaviour we have not measured.
2. **Exact geometry stays in copperhead.**
   - The packer sees boxes: courtyard bounding boxes per rotation, and pads as boxes.
   - After every phase, copperhead's own `verifyDesign` (exact courtyard polygons) is the judge.
   - A phase whose result overlaps under exact geometry retries its conflicting parts once with a larger gap before being accepted as a candidate with findings.
3. **The attractor encoding uses the packer's network model.**
   - A reference pull, region hint or critical pin becomes a point-sized static "network reference" part carrying one pad on a private network, with the released part carrying a matching virtual pad at its centre.
   - Weights reach the cost through patch P3 (a per-network weight map). This is the mechanism core already uses for other-side parts.
4. **Phases are separate packer runs.** Earlier phases are static.
   - Two-level islands:
     1. pack each island subsystem's released parts in a local frame, with the subsystem's static members and outside-net attractors;
     2. turn the result into one composite part (pads at offsets, box of extents);
     3. pack composites on the board;
     4. expand the result.
   - A failure falls back to flat packing for that phase.
5. **Classification lives in `src/pcb/intent/critical.ts`,** beside `blocks.ts`, so engines may import it.
   - Rules are table-driven: pin-function and net-name regular expressions plus reference-prefix and footprint-library patterns.
   - Weights: `hot-loop` 8, `supply-decoupling` 6, `bootstrap`/`config`/`crystal`/`output-chain` 4, `signal` 1, `low` 0.5, ground and rails 0. These are provisional per RFC 14 Appendix C.
6. **Subsystem sources extend `deriveBlocks` through a new `src/pcb/intent/subsystems.ts`,** which returns partitions (intent, sheet, anchor, louvain × clean-up). `deriveBlocks` stays the intent source. Louvain and nearest-anchor are ported from the measurement scripts in `manual-tests/runs/placer-research-2026-09-16/subsystems/`.
7. **The screening funnel runs inside the placer, not `placeBoard`.**
   - `placer-reuse-pack` produces many placements, and screens them with `verifyDesign` on an in-memory export (`applyCandidate` plus `importBoard`, no KiCad).
   - It returns the top 8 as separate candidates, each tagged with its variant key in its engine id suffix (`placer-reuse-pack#<n>`), so that `placeBoard` materialises, probes and ranks them as today.
   - Critical routing (top 5) and the probe cap (top 3) are enforced through a new `probe.maxCandidates` and a critical-routing hook.
8. **Critical routing uses `routeBoard` with `netNames`** on the materialised candidate in its own run directory, with Freerouting, 10 passes and a 45 s wall ceiling. The routed board is discarded, and only metrics are kept. Revision rules re-run the phase executor from the affected phase with the plan edited.
9. **Ranking tiers are an optional field on `ScoringProfile`.**
   - `rank()` gains a tier comparator used only when `tiers` exist.
   - `src/pcb/verify/tiers.ts` computes tier metrics from `verifyDesign` metrics plus placer metrics (loop areas, chain order, isolation margins, escape conflicts, critical routing).
   - Existing profiles and B1–B4 rankings are unaffected.
10. **The model planner lives in `src/pcb/agent/place/`** and is registered by the `pcb reuse` command only.
    - It follows the repair planner's pattern: a tool-less chat, JSON parse, validation.
    - Request and response files go under the invocation work directory as `rounds/<k>-<r>.{request,response}.json`.
    - Replay matches by a SHA-256 of the canonical request.
11. **`pcb reuse` is a new command beside `pcb place`,** which stays LLM-free. It drives `placeBoard` with a registry of the reuse engines plus `placer-fixed`, and writes `options.md` and PNG renders (SVG from `renderSvg`, converted with ImageMagick `convert`, falling back to chromium headless).
12. **The coordinate fallback is in the first release.** The P0 run settled the open question: every packed
    variant fails at V1 with unplaced parts on the four densest boards (peltier at 62 % utilisation, hbridge at
    55 %, the 12/24 boost converter, komputer-klavier), so the fallback is not a refinement of a working path
    but the only route to a candidate there.
    - The model is asked only for the stranded parts and the parts named in the gate findings, never for a whole
      board; entries outside that set are dropped.
    - It is bounded and self-checking: free space and courtyard boxes in, coordinates out, the rule stages and
      `verifyDesign` after every answer, at most 3 rounds. A bad answer costs a round, not a board.
    - It runs only with `--model` and produces its own candidate, so a run without a model is unaffected.

## Risks / Trade-offs

- **The vendored packer may misbehave on real footprints** (very large boxes, THT rows). → Exact verification after every phase, retries, flat fallback, and a partial status that names parts. The benchmark measures it.
- **Box geometry wastes space on dense boards.** → Report box utilisation. Stage 5 of RFC 14 adds exact rectangles later.
- **Model calls through `claude-code` are slow** (minutes) and the SDK binary occasionally fails to launch. → Budgets, replay, and deterministic plans always compete. Benchmark model runs are limited to a subset.
- **Critical routing is costly with the JRE.** → Top 5 only, 45 s each, one at a time, and `--no-critical-routing` for fast runs.
- **Rule classification errs on unusual pin naming.** → Soft severity, recorded sources, and the benchmark's intent metrics catch misses.
- **`@ts-nocheck` hides type errors in vendored code.** → Typed facade, unit tests per patch, and a smoke test on golden boards.

## Migration Plan

This is additive. `pcb place`, `pcb layout`, `create` stage 5 and all existing profiles keep their behaviour. There is no data migration. Rollback is removing the command registration and the dependency.

## Open Questions

These are recorded in RFC 14 Appendix C.2 and left open by the owner:
- class weights and tier tolerances;
- funnel sizes and variant budget;
- the model's freedom to reorder phases;
- the critical routing budget;
- a routability floor;
- the island size limit.

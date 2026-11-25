# add-pcb-layout-framework: Design

RFC 11 carries the architecture, prior art, and rationale; this document records only the decisions that bind the RFC to this repository and resolves the RFC's open decisions (Appendix C.2) where a default exists. The engineering-level detail (modules, types, on-disk formats, process protocol, commands, tests) is in [implementation.md](implementation.md).

## Context

See RFC 11 §1.4 for what already exists in the tree and §4 for the neighbours. The load-bearing facts: the read-only sexp reader and the template emitter are the round-trip pattern; `board.ts` already turns a schematic into a populated board; `report.ts` already normalizes DRC into error / warning / unrouted; the constraint registry already carries `source` and `affects`; the draft engine already proves intent-in, geometry-out. PR #253's bridge established the Specctra conventions (KiCad's own exporter as the dialect, resolution-unit coordinates in Freerouting's SES) that `router-freerouting` will reuse.

## Goals / Non-Goals

**Goals:** RFC §1.2, verbatim. **Non-Goals:** RFC §1.2 and §3.8, verbatim.

## Decisions

- **D1: Directories now, packages later (§13.5.1, Appendix C.2 item 10).** `src/pcb/ir`, `src/pcb/engines`, `src/pcb/verify`, `src/pcb/agent`, and a top-level `bench/` in this repository, with a test asserting the import direction (everything points inward to `ir`; `agent` never imports an engine wrapper; nothing on `check`'s path imports `agent` or a wrapper whose manifest declares `networkRequirement: required`). Splitting into `packages/` or a separate `copperbench` repo waits for a second contributor and stable schemas. Alternative: start as a monorepo — rejected as build-system work with no user yet.

- **D2: TypeScript geometry, JSON Schema contracts (Appendix C.2 item 1, Appendix C.2 item 3).** Orchestration and the IR in TypeScript; integer nanometres as `bigint`-free `number` (a 1 m board is 10⁹ nm, inside 2⁵³); polygon operations through one vetted kernel chosen in Phase 0 (Appendix C.2 item 2, candidates: `polygon-clipping`, `martinez`), wrapped behind `src/pcb/ir/geometry.ts` so it can be replaced by a Rust binding if profiling demands. Plugin contracts published as JSON Schema generated from the TypeScript types, so a Python engine wrapper validates against the same schema.

- **D3: KiCad 10 pinned (§6.4, Appendix C.2 item 4).** KiCad 10.0.x is the current stable on this machine and in CI; the adapter targets one major at a time and `doctor` reports the mismatch. KiCad 9 boards are imported when they parse (same s-expression schema family) and exported in the version the project file declares.

- **D4: The adapter reuses the existing round-trip pattern.** Import is a read-only parse (extending `sexp.ts` with the board-side reader, closing #8); export of a candidate is text surgery on the immutable source copy: footprint `(at …)` records replaced in place, engine copper appended before the closing paren with UUIDv5 ids from semantic paths, zone definitions untouched and refilled through `kicad-cli pcb` (or, where the CLI cannot refill in the pinned version, through a pinned `pcbnew` script recorded in the manifest as a tool dependency). Nothing serializes the parsed tree.

- **D5: Critical DRC violation (Appendix C.2 item 5).** An error-severity DRC finding of any type except `lib_footprint_mismatch`, `silk_over_copper`, and the silk/courtyard families the profile lists as advisory; `unconnected_items` are never violations, they are completion. The definition lives in the fabrication profile so a stricter profile can promote a family.

- **D6: Default fabrication profile (Appendix C.2 item 6).** `jlcpcb-2layer` from kicad-tools' rule set, vendored as JSON with its upstream commit hash; the profile names the DRC families it treats as critical (D5), the edge clearance, and the via/track minimums the physics compiler gates on.

- **D7: kicad-tools is vendored selectively (Appendix C.2 item 8).** Phase 0 decides per module; the default is to vendor the fab profiles as data and to wrap DRC and the engines out of process (`executionMode: process`), never importing Python into the Node runtime.

- **D8: Statuses replace the ad-hoc outcome vocabulary.** `PASS`, `PARTIAL`, `HOLD`, `REFUSE`, `UNSUPPORTED`, `TIMEOUT`, `ENGINE_ERROR`, `INVALID_OUTPUT` are one enum in `src/pcb/ir/status.ts`; `create` maps `PASS`/`PARTIAL` to stage completion with the evidence bundle, `HOLD` to a halt with the resume hint, `REFUSE` to the existing refusal path.

- **D9: Constraint registry extension is additive.** Existing electrical constraints keep their shape; layout constraints add `class`, `severity`, `scope`, `parameters`, `priority`, `confidence`, `approvedBy`. `record_constraint` accepts the new fields; the drift check and `check` treat a layout constraint as a claim the intent checker validates. ECAD-ingested constraints are written with `source: ecad_rules` and re-derived on every import, never hand-edited.

- **D10: Freerouting packaging (Appendix C.1).** Run as a separate process on a user-installed jar and JRE, discovered from `COPPERHEAD_FREEROUTING_JAR`, config, or the KiCad plugin directory; never bundled. The manifest records the jar version and the JRE requirement (2.4.x needs a JRE 25), and `java-too-old` is a named `ENGINE_ERROR` detail.

- **D11: Evidence bundle format.** `.copperhead/runs/<ts>/layout/` holds the snapshot hash, every candidate's IR, diagnostics, metrics, engine provenance, and the ranking; `docs/LAYOUT.md`'s `## Draft quality` is generated from it and only annotated by the model. Hashes make the bundle reproducible and the fab gate's freshness check can read them.

## Risks / Trade-offs

RFC Appendix C.1 verbatim, plus:

- [Phase 0 teardowns find PCBWorld or kicad-tools licenses incompatible] → the affected layer falls back to the "build" column of §4.2 for that layer only, recorded as an ADR; the schedule slips by that layer, not the plan.
- [The checkpoint after Phase 2 ships the routing harness alone] → stage 5 still improves: populated, DRC-verified, routed by a wrapped engine with evidence, and the model only moves parts; placement intent arrives with Phase 3–4.
- [Two round-trip mechanisms (draft emitter for schematics, adapter for boards)] → both are template-plus-read-only-parse; the shared UUIDv5 and number formatting helpers move to `src/kicad/emit.ts`.

## Migration Plan

Additive. No existing command changes behaviour until stage 5 is switched (Phase 5), which is one reviewed change gated on B0–B3 evidence. Rollback at any phase is not invoking the framework. On archive, SPEC.md §3.8 "First-draft layout" is rewritten around the evidence bundle and the AC-17.x criteria are merged.

## Open Questions

RFC Appendix C.2 items 2, 7, and 9 remain open until Phase 0; the rest are resolved above.

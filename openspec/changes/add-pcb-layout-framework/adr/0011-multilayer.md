# ADR 0011: Up to six copper layers

**Status:** Accepted (2026-09-07)
**RFC:** 11 §6, §7 (stackup class), §9.5, Appendix B.8
**Change:** `add-multilayer-layout` (proposal, design D1 to D8, delta specs)

The layout framework was specified and measured for two copper layers. This ADR records the decisions that took it to six, and the evidence.

## Decisions

1. **The copper stack is derived from the layer names, not the layer numbers.** `copperStack()` orders `F.Cu`, `In1.Cu` … `InN.Cu`, `B.Cu`; KiCad's legacy numbering (`In1.Cu` 1, `B.Cu` 31, which the golden corpus carries) and its current one (`B.Cu` 2, `In1.Cu` 4, `In2.Cu` 6, which KiCad 10 writes and the multilayer golden boards use) give the same stack. Every copper-layer site in `src/pcb` reads it from one helper. A board with more than six copper layers, an unnameable copper layer, or a gap in the inner numbering is refused at pre-flight with `preflight.stack`.
2. **Through vias only.** A via's span is the stack slice between its ends; connectivity joins copper across the whole span (the defect that read a fully routed four-layer board as 17 % complete is gone). A via whose ends are not the outer layers fails the routing gate with `geom.via-layers`, and an engine returning one makes the invocation `INVALID_OUTPUT`. Blind and buried vias wait on a profile and an engine that declare them; the `via-span` golden board (blind vias in KiCad's file grammar) keeps the refusal honest.
3. **Profiles by copper count.** `jlcpcb-4layer` and `jlcpcb-6layer` are vendored from the same kicad-tools table as `jlcpcb-2layer` (`4layer_1oz`, `6layer_1oz`: 0.1016 mm / 0.0889 mm clearance and track, 0.2 mm via drill, 0.45 mm via, 0.4 mm hole-to-edge), with their `.kicad_dru` files beside them. A board defaults to the profile for its count; a configured profile for another count is `preflight.profile`.
4. **Engines get the count from the stack.** kicad-tools is called with `--layers 2|4|6`; Freerouting's DSN carries the stack in order with a default inner-layer direction strategy (In1.Cu horizontal, In2.Cu vertical, alternating; intent `routing.layers` overrides); OrthoRoute is eligible at four layers and up by its manifest; the reference router keeps `maxLayers: 2`.
5. **Scoring on four and six layers drops the bottom-layer return-path terms** (`default-low-speed-4-layer`, `-6-layer`: the two-layer weights without `pour_largest_share` and `bottom_signal_length_nm`, renormalised); the return-path checker already reports `NOT_APPLICABLE` off two layers. A plane-integrity metric is the next step, not built here because no wrapped engine pours inner planes.
6. **Unrouted counts match KiCad.** Copper of a net touching no pad is an island of its own, as KiCad's unconnected-items count treats it. Two-layer golden expectations were unchanged by this; the `via-span` board is where it shows (15, not 14).
7. **Renders draw the stack** back to front, inner layers in their own colours.

## Evidence

- Every two-layer golden board regenerates byte for byte with the new generator; every two-layer expectation and the B1 to B4 numbers stand (full suite green after the change).
- Live: Freerouting routes the four-layer golden (`completion` on four layers) and the verifier reads it complete, with copper on In1.Cu and In2.Cu and every via a through via (`test/pcb-layers.test.ts`, gated).
- M1 bench, `bench/suites/multilayer-microboards.json` with `router-freerouting`, `router-kicad-tools`, `router-orthoroute`: two of the three boards route clean and the third owes one connection. `four-layer`: Freerouting 100 % in 4 s, 143 mm, 10 vias, 0 DRC errors, selected; kicad-tools 33 % in 142 s. `six-layer`: Freerouting 95 % in 74 s (one connection owed, 771 mm, 20 vias, 0 DRC errors), kicad-tools declined the board on its grid rule, OrthoRoute returned no copper. `via-span`, whose seeded copper track B strips before routing, routes like the four-layer board (Freerouting 100 %, 143 mm, 10 vias). OrthoRoute on the two four-layer boards returned vias from F.Cu to In2.Cu, blind vias, and the harness rejected both invocations as `INVALID_OUTPUT` naming the via: it routes with blind and buried vias by default, so it stays unusable here until those are supported. Regret 0, invalid-over-valid 0, harness overhead 13 s per board. Run: `bench/var/runs/M1-multilayer`, report `bench/reports/M1-2026-09-07.md`.

## What this leaves

- Blind and buried vias, per-layer widths, impedance and stackup materials, plane splitting: outside this change (proposal, "Not in this change").
- A four-layer PCBench suite (task 7.4) waits on disk for the corpus clone; the claim for six layers is "the harness handles the stack", measured on a synthetic board.
- Renders show inner copper; the collage tooling needs nothing.

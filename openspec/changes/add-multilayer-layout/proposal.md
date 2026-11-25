## Why

The layout framework (`add-pcb-layout-framework`, RFC 11) is specified and measured for two-layer boards: one fabrication profile, a scoring profile whose return-path terms read the bottom layer, a renderer that draws two copper layers, engines told `--layers 2`, and a copper stack the importer orders by KiCad's layer number, which differs between the legacy numbering the golden boards carry (In1.Cu = 1, B.Cu = 31) and the numbering KiCad 10 writes (B.Cu = 2, In1.Cu = 4, In2.Cu = 6). A four-layer variant of a golden board showed what that costs today: Freerouting finishes it with no unrouted connection by its own count and the verifier reads 17 % complete, because a through via joins only its two end layers in the connectivity check and inner-layer copper never connects; the renders of the same board show a bare outline because inner copper is not drawn. RFC 11 Appendix B.8 places four-layer profiles in Phase 6 and §7 says the stackup constraint class "exists so four-layer is additive". The corpus has 126 four-layer PCBench boards the harness cannot look at, and the first router wrapped after B4 (`router-orthoroute`, ADR 0010) is a four-layer-and-up engine with nothing to run on.

## What Changes

- **Canonical copper stack.** The IR orders copper layers as a stack, F.Cu, In1.Cu … InN.Cu, B.Cu, from the layer names, whichever numbering the file uses; every consumer (DSN emitter, SES importer, ORP emitter, renderer, connectivity, geometry, metrics) reads the stack from one helper instead of filtering and sorting layers itself. Boards with more than six copper layers, or with copper layers the stack cannot name, are refused at pre-flight with the reason.
- **Vias span the stack.** A through via joins every copper layer between its two ends in the connectivity check; the geometry check requires both ends to be stack members and, on this change, the ends to be the outer layers (blind and buried vias are `UNSUPPORTED` until an engine and a profile declare them). Engines returning a via with any other span get `INVALID_OUTPUT`.
- **Four- and six-layer fabrication profiles.** `jlcpcb-4layer` and `jlcpcb-6layer`, vendored from the same kicad-tools data as `jlcpcb-2layer` (ADR 0006) with the per-layer-count clearance, track, and via values, and the same critical DRC list. A board's profile defaults to the one matching its copper count when the configuration names none; a configured profile whose layer count differs from the board is a pre-flight refusal.
- **Engines take the board's layer count.** kicad-tools is called with `--layers 2|4|6` from the stack; the Freerouting DSN carries every copper layer (it already does) with a default direction strategy for inner layers (alternating horizontal and vertical, outer layers free) that a `routing.layers` intent entry can override; `router-orthoroute` becomes eligible at four layers and up; the reference router stays two-layer (`maxLayers: 2`).
- **Verification and scoring are layer-aware.** The return-path metrics (`bottom_signal_length_nm`, `pour_*`) apply to two-layer boards; on four and six layers the plane layers are the return path, so the scoring profile for those boards drops the bottom-layer terms and adds nothing in their place (a plane-integrity metric is later work, named in design). The congestion capacity already scales with copper count.
- **Renders draw every layer.** Inner layers are drawn under the outer layers in their own colours with a legend entry; pads on inner layers (through-hole) are drawn on each.
- **Golden multilayer microboards and a bench suite.** The golden generator takes a layer count and emits the KiCad 10 numbering; three new cases (`four-layer`, `six-layer`, `via-span`, the last seeding a buried via that must be refused) join the corpus with expected results; `bench/suites/multilayer-microboards.json` runs them through routing with every wrapped router, and the PCBench qualification pool admits the permissively licensed four-layer boards that upgrade and pass DRC as a separate `pcbench-4layer` suite.
- **Not in this change:** blind and buried vias, per-layer track widths, impedance or stackup-material data, plane splitting, and any placer change (placement is layer-agnostic already).

## Capabilities

### New Capabilities
- `pcb-multilayer`: the copper stack model (order, naming, limits), via spans, layer-aware profile selection and scoring, and the multilayer bench corpus. Kept as one capability so the two-layer specs stay readable; its requirements reference the capabilities below where they extend them.

### Modified Capabilities
- `pcb-ir`: the copper stack replaces "copper layers in layer-number order"; via layer semantics; pre-flight refusal for unsupported stacks. (Delta spec in `add-pcb-layout-framework`, not yet archived; this change depends on that archive landing first or on being archived with it.)
- `pcb-verification`: connectivity across the stack; the via geometry check; profile selection by copper count; return-path metrics scoped to two layers.
- `pcb-engine-contracts`: `minLayers`/`maxLayers` capabilities honoured by the registry (min already landed in ADR 0010); the layer count and stack handed to every router; `INVALID_OUTPUT` for a via outside the through span.
- `copperbench`: the multilayer golden cases and suites; the PCBench four-layer pool.

## Impact

- `src/pcb/ir/` (layer table, stack helper, import, export), `src/pcb/verify/` (connectivity, geometry, profiles, return path, scoring), `src/pcb/engines/` (plan, routers' adapters, registry), `src/pcb/ir/svg.ts`, `bench/golden/generate.ts` and three new golden directories, `bench/suites/`, `bench/corpora/pcbench.sh` (four-layer pool), docs (`layout-framework`, configuration, CLI).
- Depends on `add-pcb-layout-framework` (all of its code); no new external dependency. kicad-tools 0.20.0 and Freerouting 2.4.1 both route six layers; OrthoRoute runs at four and up.
- Behaviour on two-layer boards is unchanged; every existing golden expectation and B1 to B4 number must reproduce.

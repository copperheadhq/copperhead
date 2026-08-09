# add-circuit-json-export — Design

## Context

The draft pipeline is a small compiler: `schematic.intent.json` (IR, no coordinates) → `draftSchematicPlacement()` (engine, computes all geometry into a `PlacementModel`, `src/kicad/draft/engine.ts:328`) → `emitSchematic()` (backend, deterministic KiCad text, `src/kicad/emit.ts`). This change adds a second backend over the same lowered model, serializing to tscircuit's circuit-json interchange format, exposed as `copperhead export circuit-json` beside the existing `export bom` (which sets the contract: deterministic, LLM-free, network-free, writes to `outputs/`, `src/commands/export.ts`).

Constraints inherited from issue #178 and SPEC §1.3: circuit-json is a derived read-only view only; no circuit-json or KiCad serializer may enter the mutation path; `sexp.ts` stays read-only and is not touched by this change.

## Goals / Non-Goals

**Goals:**

- Deterministic circuit-json export of a drafted schematic: same intent → byte-identical JSON on any machine.
- The exported JSON depicts exactly the sheet that was drafted and ERC-checked, and the command refuses when it cannot promise that.
- Output validates against the `circuit-json` package's own Zod schemas (proven in tests, offline).

**Non-Goals:**

- Lifting circuit-json from a `.kicad_sch` (init'd or hand-edited projects): the command refuses these with an actionable message.
- circuit-json import, `pcb_*` elements, viewer integration, create-pipeline integration (all recorded out of scope in the proposal).

## Decisions

### CJ-D1: Serialize from ValidatedIntent + PlacementModel, not from the .kicad_sch

The engine already computed every position; re-deriving nets from drawn wires and labels is the hard, error-prone direction (a lifter). The serializer is a pure function `buildCircuitJson(validated, model)` with no I/O, mirroring how `emitSchematic(model)` is pure. Alternative rejected: intent-only export (no geometry, renderers would autolayout a different-looking sheet than the one copperhead drew).

### CJ-D2: Staleness gate — re-draft and compare against the on-disk schematic

`export circuit-json` re-runs the engine on the on-disk intent and emits KiCad text via the existing `emitSchematic()`; if that text does not byte-match the on-disk `.kicad_sch`, the export refuses ("schematic does not match the intent; re-draft first"). This is what makes the "depicts the drafted sheet" promise checkable rather than asserted, and it is cheap because both stages are deterministic. The title-block date is read from the on-disk schematic's `(date "…")` entry so a sheet drafted on an earlier day still compares equal (the engine takes `today` as an input precisely so identical IR emits identical bytes on any day).

### CJ-D3: Plain-JSON emission; `circuit-json` is a devDependency only

The serializer builds plain objects and `JSON.stringify`s them with a fixed 2-space indent and canonical element order. The npm package `circuit-json` (pinned exact version) is used only in tests, where every emitted element is parsed with the package's `any_circuit_element` Zod schema. Alternative rejected: using the package's builders at runtime — adds a runtime dependency and version coupling for no expressive gain; the format is JSON.

### CJ-D4: Deterministic ids from canonical order

circuit-json ids are strings (`source_component_0`, `schematic_component_3`, …). Ids are assigned ordinally after sorting elements canonically (components by refdes natural order, nets by name, traces by net then wire index — the same discipline `emit.ts` uses for UUIDs). Same intent → same ids → byte-identical file. No wall-clock, no randomness (repo-wide rule; also required for the CJ-D2 comparison).

### CJ-D5: Element mapping and coordinate convention

| copperhead source | circuit-json elements |
| --- | --- |
| `IntentPart` + `ResolvedSymbol` | `source_component` with `ftype: simple_chip` universally (typed ftypes like `simple_resistor` require parsed electrical values the free-text intent value cannot promise; `display_value` carries the value), one `source_port` per `DraftPin` |
| `IntentNet` | `source_net`; its `pins` become the `source_trace`'s `connected_source_port_ids` |
| `noConnect` ("REF.PIN") | the matching `source_port` is simply absent from every `source_trace` (circuit-json has no no-connect marker) |
| `EmitSymbol.at` + symbol body bounds | `schematic_component` (center + size; the schema has no rotation field — orientation is carried by the port positions, and the engine only places at rotation 0) |
| symbol pin connection points | `schematic_port` (position derived from symbol `at` + rotated `DraftPin` offset) |
| `PlacementModel.wires` grouped by net | `schematic_trace` with a polyline route |
| `PlacementModel.labels` | `schematic_net_label` |

Coordinates: KiCad schematic space is mm with +y down; circuit-json schematic space is unit-based with +y up, and tscircuit renderers size text/ports in those units (grid step 0.2 units). The mapping negates y and scales one KiCad 100 mil grid step (2.54 mm) to one 0.2-unit step (`SCH_UNITS_PER_MM`), so renders keep tscircuit-native proportions; raw mm coordinates render with ~13x-too-small text. Both live in one `toCj({x, y})` helper with a unit test pinning a known symbol, so the convention lives in exactly one place. Exact field names follow the pinned `circuit-json` version's types; the schema-validation tests are the enforcement, so a field-name drift fails loudly in CI rather than silently emitting junk.

### CJ-D6: CLI shape and output path

`copperhead export circuit-json [--out <repo-relative path>]`, default `outputs/circuit.json`. Same refusal style as `export bom`: missing intent file → actionable error naming the file and the drafted-projects-only scope; staleness (CJ-D2) → error telling the user to re-draft. The command module keeps `export.ts`'s header contract: never imports a provider, no network.

## Risks / Trade-offs

- [circuit-json format evolves under 0.0.x versioning] → exact-pin the devDependency; tests validate every element against the package schemas, so an upgrade that changes field names fails tests instead of shipping bad output.
- [Rotation/mirror conventions differ subtly between KiCad and tscircuit renderers] → the engine only emits rotations in {0, 90, 180, 270} and never mirrors; the single `toCj` helper plus a fixture-pinning test bounds the blast radius.
- [CJ-D2 comparison is byte-exact, so any future emit.ts format change invalidates old drafts' exports] → acceptable: the refusal message says to re-draft, and re-drafting is the supported regeneration path for drafted sheets.
- [`ftype: simple_chip` for every part loses component-kind typing] → deliberate: typed ftypes demand parsed values (resistance, capacitance) and a wrong parse would be worse than an untyped part; affects only downstream cosmetic rendering, never connectivity.

## Open Questions

None blocking. Whether `create` should emit the file as a stage-6 sibling artifact is deferred until the standalone command is proven (same sequencing supplier-bom-export used).

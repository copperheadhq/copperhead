# add-circuit-json-export — Proposal

## Why

A drafted design's only machine-readable artifact is the emitted `.kicad_sch`, so every external consumer (netlist tooling, converters, fixtures) has to lift KiCad s-expression text. The tscircuit ecosystem already speaks one interchange format, circuit-json (typed JSON elements with published Zod schemas), and the draft pipeline already computes everything needed to emit it: the intent IR carries the logical netlist and the engine's placement model carries the geometry. Tracked as issue #231; scoped to comply with the standing constraint from issue #178 that circuit-json may only ever be a derived read-only view.

## What Changes

- New deterministic serializer module that maps the draft engine's `PlacementModel` plus the validated intent to a circuit-json document: `IntentPart` → `source_component` (+ `source_port` per pin), `IntentNet` → `source_net`/`source_trace`, `noConnect` carried through, and the engine's computed placement filling the `schematic_component`/`schematic_port` layer.
- New CLI subcommand `copperhead export circuit-json`, sitting beside `export bom` with the identical contract: deterministic, zero LLM calls, zero network calls, output written to `outputs/`.
- `copperhead create` is NOT modified: the export is a standalone command in v1 (the create pipeline can adopt it later, mirroring how supplier BOM export was proven standalone first).
- Out of scope, recorded so nobody re-litigates: lifting circuit-json from a `.kicad_sch` (init'd/hand-edited projects), circuit-json import (circuit-json → KiCad), any viewer integration, and any `pcb_*` element emission.

## Capabilities

### New Capabilities

- `circuit-json-export`: derived read-only circuit-json serialization of a drafted schematic (source layer from the intent IR, schematic layer from the engine placement model), exposed as `copperhead export circuit-json`.

### Modified Capabilities

- `cli-surface`: the command set grows `export circuit-json [--out <path>]`; `export` becomes a command family with two subcommands.

## Impact

- New code: `src/kicad/draft/circuit-json.ts` (serializer), wiring in `src/commands/export.ts` and `src/cli.ts`.
- No changes to `src/kicad/sexp.ts` (stays read-only, untouched), `src/kicad/emit.ts`, the draft engine, agent tools, or any mutation path — both repo invariants (spec-gated in, verification-gated out) are unaffected.
- New dev dependency `circuit-json` (types + Zod schemas), used in tests to validate emitted output; the runtime serializer emits plain JSON and does not require the package at runtime.
- Tests: golden/determinism tests (same intent → byte-identical JSON) and schema-validation tests against the `circuit-json` package, all offline.

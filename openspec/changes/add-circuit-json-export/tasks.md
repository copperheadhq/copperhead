# add-circuit-json-export — Tasks

## 1. Setup

- [x] 1.1 Add `circuit-json` (exact-pinned) to devDependencies; confirm it imports offline in a scratch test
- [x] 1.2 Locate the intent-file path convention used by `draft`/`create` (config vs fixed path) and the fixture repo with a drafted sheet to test against; add a minimal drafted fixture if none exists

## 2. Serializer

- [x] 2.1 Create `src/kicad/draft/circuit-json.ts`: `buildCircuitJson(validated: ValidatedIntent, model: PlacementModel): CircuitJsonDocument` — pure, no I/O
- [x] 2.2 Source layer: `source_component` per part (ftype from libId-prefix map, default `simple_chip`), `source_port` per `DraftPin`, `source_net` + `source_trace` per intent net, `noConnect` pins in no trace (design CJ-D5)
- [x] 2.3 Schematic layer: `schematic_component` from `EmitSymbol.at`, `schematic_port` from rotated pin offsets, `schematic_trace` from wires grouped by net, `schematic_net_label` from labels; single `toCj` y-negation helper (CJ-D5)
- [x] 2.4 Deterministic ids from canonical sort order (CJ-D4) and stable `JSON.stringify` serialization (2-space indent, fixed key order per element)

## 3. Command

- [x] 3.1 Add `runExportCircuitJson()` to `src/commands/export.ts`: load intent, validate, re-draft, staleness gate vs on-disk `.kicad_sch` using the file's title-block date (CJ-D2), write `outputs/circuit.json`
- [x] 3.2 Refusals: missing intent file, stale/hand-edited sheet — actionable messages, non-zero exit, no partial output (spec: drafted-projects-only refusal)
- [x] 3.3 Wire `export circuit-json [--out <path>]` into `src/cli.ts` beside `export bom`, honoring `--repo` and `--json`

## 4. Tests

- [x] 4.1 Schema validation: every emitted element parses with the pinned `circuit-json` package's Zod schemas on the drafted fixture
- [x] 4.2 Determinism: two runs on the same fixture are byte-identical; refdes/net sets in the JSON equal the intent's
- [x] 4.3 Connectivity: net pins map to the right `source_port` ids; `noConnect` pin absent from all traces
- [x] 4.4 Coordinate pin test: one known symbol's `schematic_component` position/rotation matches the y-negated `EmitSymbol.at`
- [x] 4.5 Refusal paths: no intent file; mutated `.kicad_sch` byte → non-zero exit, correct message, no output written

## 5. Finish

- [x] 5.1 `npm run typecheck`, `npm test` (offline), `npm run build` all green
- [x] 5.2 `openspec validate add-circuit-json-export` passes
- [x] 5.3 Update docs: README/CLI help text mention `export circuit-json`; note the derived-read-only constraint (issue #178) in the command's header comment

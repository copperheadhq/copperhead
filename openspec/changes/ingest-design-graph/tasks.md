# Tasks: ingest-design-graph

## 1. Symbol enrichment

- [x] 1.1 Extend `SchematicSymbol` with datasheet, fields, dnp, inBom, onBoard; parse all `property` entries plus `(dnp)`, `(in_bom)`, `(on_board)` in `symbolsOf`
- [x] 1.2 Add `mpnOf`, `manufacturerOf`, `lcscOf` field pickers (case-insensitive, alias-tolerant)

## 2. Netlist graduation

- [x] 2.1 Graduate `test/support/netlist.ts` to `src/kicad/netlist.ts` with fields, datasheet, description, tstamps, units, sheetFile, pintype, pinfunction, netclass
- [x] 2.2 Keep the test helper as a re-export so corpus tooling and product share one extractor

## 3. Design graph

- [x] 3.1 Add `src/kicad/design-graph.ts` with versioned shape, derived classification, `buildGraph`, `extractDesignGraph`, `writeDesignGraph`, `readFreshGraph`
- [x] 3.2 Prefer the `kicad-cli` netlist export; fall back to the s-expression parse with a partial flag (offline-safe)

## 4. Init and drift integration

- [x] 4.1 Scaffold BOM from real MPNs when present (UNVERIFIED placeholder otherwise); omit DNP and BOM-excluded parts
- [x] 4.2 Scaffold PINOUT from derived ic and connector classification (not a U prefix)
- [x] 4.3 Drift skips DNP and BOM-excluded symbols when checking for missing rows
- [x] 4.4 `init` writes `.copperhead/design-graph.json` without blocking docs on graph failure

## 5. CLI

- [x] 5.1 Add `copperhead ingest` (writes the graph; `--json` emits it)

## 6. Verification

- [x] 6.1 `test/design-graph.test.ts` (fields, MPN preservation, DNP omission and drift, classification, netlist identity fields and escapes, netlist-first graph, freshness, init graph write, fallback, ingest CLI)
- [x] 6.2 `npm run typecheck` clean; offline subset green (design-graph, sexp, bom-table, bom-export, docs-drift, cli-surface)
- [x] 6.3 SPEC AC-1.2 and AC-1.3 updated; CLI surface documents `ingest`

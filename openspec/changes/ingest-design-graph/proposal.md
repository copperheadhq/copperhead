# ingest-design-graph: Proposal

## Why

When copperhead is pointed at a KiCad project it did not create, ingestion is lossy in specific, verifiable ways (issue #248). Every symbol property except Reference, Value, and Footprint is dropped, so a well-maintained project with real MPNs gets UNVERIFIED written for all of them. DNP and BOM-excluded parts become orderable rows. Chips are a string prefix (`ref.startsWith('U')`), so connectors, regulators addressed as VR1, MOSFETs, and crystals never make the pinout. Connectivity is re-derived by hand with no bus, hierarchy, or T-tap handling. The authoritative `kicad-cli sch export netlist` is already run as a loadability probe and discarded. The board is never ingested, and the one good extractor lives in `test/` and never ships.

This change is pipeline step 1 for the hybrid board review (#247) and the fix for redundant schematic parsing (#229). It produces one normalized, versioned design graph that every other consumer reads instead of re-parsing.

## What Changes

- New command `copperhead ingest` (LLM-free, network-free): parse the project into `.copperhead/design-graph.json`, preferring the `kicad-cli` netlist export for connectivity and part identity, falling back to the s-expression parse when the export cannot be produced.
- `copperhead init` runs ingestion, then generates docs from the enriched symbols: real MPNs preserved, DNP and BOM-excluded parts omitted from BOM.md, pinout classification derived from library, footprint, and pin count.
- `src/kicad/netlist.ts` graduates from `test/support/netlist.ts` with extended fields (fields, datasheet, pintype, pinfunction, netclass, tstamps, units, sheet file). The test helper re-exports from the product module so corpus tooling and product share one extractor.
- Drift skips DNP and BOM-excluded symbols when checking for missing BOM rows, so their intentional absence is not flagged.
- SPEC AC-1.2 and AC-1.3 updated; CLI surface documents `ingest`.
- Part and pin identity come from the netlist when produced; every sheet file is hashed for freshness; the graph file is a gitignored cache.

## Capabilities

### New Capabilities

- `design-graph-ingest`: the normalized graph shape, netlist-first parts and connectivity, classification, freshness, and the gitignored cache.

### Modified Capabilities

- `cli-surface`: the CLI gains the `ingest` command (new requirement).
- `docs-memory`: `init` scaffolds BOM and PINOUT from enriched symbols (AC-1.2, AC-1.3), and drift and the draft BOM cross-check honour DNP and BOM-excluded parts.

## Upgrade notes

- Repos initialised before this change may hold BOM.md rows for DNP or BOM-excluded parts. `copperhead check` now reports those rows as orderable. Remove the rows, or re-run `copperhead init --force`.
- The first `copperhead init` or `ingest` appends `.copperhead/design-graph.json` to `.gitignore`. Commit that line, or `do` refuses on the dirty tree.

## Impact

- Code: `src/kicad/sexp.ts` (fields, datasheet, dnp, inBom), `src/kicad/netlist.ts` (new), `src/kicad/design-graph.ts` (new), `src/memory/scaffold.ts`, `src/memory/drift.ts`, `src/cli.ts`.
- Tests: `test/design-graph.test.ts`, existing offline suite stays green.
- Dependencies: none new. Board stats and pos ingestion stays a follow-up; the graph carries `board: null` in v1.
- Unchanged contracts: `check` stays LLM-free and network-free; the s-expression parser stays read-only; edits still use anchored text replace.

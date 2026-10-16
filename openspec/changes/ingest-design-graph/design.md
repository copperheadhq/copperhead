# ingest-design-graph: Design

## Decisions

- D1: `kicad-cli` export is the source of truth for connectivity, part identity, and BOM fields when producible. Rationale: KiCad flattens hierarchy, resolves buses, and names every net, including unnamed ones. The hand-rolled union-find stays as the offline fallback, not the primary path.
- D2: The s-expression parser stays the source of truth for geometry (symbol positions, wire routes, text placement). No export gives geometry, so the legibility checker and drafting engine keep using it unchanged.
- D3: A part with no MPN is reported as having no MPN in the graph (`mpn: ''`). The BOM scaffold keeps the UNVERIFIED placeholder for missing MPNs so existing drift and export behavior (which treat it as missing) is unchanged. Real MPNs from schematic fields are preserved verbatim.
- D4: DNP and BOM-excluded parts are omitted from BOM.md and skipped by drift. Rationale: they must never become orderable rows, and their intentional absence is not drift.
- D5: Classification is derived from library category, footprint family, and pin count, with raw evidence kept (`classEvidence`). Pinout-worthy means ic or connector. Passives (2-pin R/C/L) and mechanicals stay out of the pinout.
- D6: The graph is a derived artifact with source hashes. Readers treat a missing, version-mismatched, or stale graph as absent. Nothing commits to it as a second source of truth.
- D7: Dynamic imports for `kicad-cli` access from scaffold and design-graph. Rationale: avoids a static cycle (`cli` imports `scaffold`; both need the netlist exporter). The `check` module graph never imports a provider or the agent loop.

## Shape (v1, schematic only)

Versioned JSON at `.copperhead/design-graph.json` with `version`, `generated` (kicadCli, partial, partialReason, sources with sha256), `parts` (ref, uuid, value, libId, footprint, class, classEvidence, sheet, sheetFile, dnp, excludeFromBom, fields, mpn, manufacturer, lcsc, datasheet, description, units, pins with num, name, type, net), `nets` (name, netclass, nodes with ref, pin, pintype, pinfunction), `board: null`, and an empty `sync` placeholder for the schematic-to-PCB comparison follow-up.

## Non-goals

- Board stats, pos, zones, stackup, and ipc2581 ingestion (follow-up; the issue lists them as cheap but they need golden outputs per KiCad version).
- Part-research tools and datasheet cache (separate change `add-part-research-tools`; not implemented incidentally).
- Deterministic analysis rules and the LLM review pipeline (#247 consumes this graph; not built here).

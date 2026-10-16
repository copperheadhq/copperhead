# cli-surface: ingest command

## Added

- `copperhead ingest [--json]`: parse the configured schematic into `.copperhead/design-graph.json`. Emits part, net, and identity data normalized from the `kicad-cli` netlist export when producible, else from the s-expression parse (marked partial). Deterministic, LLM-free, network-free.

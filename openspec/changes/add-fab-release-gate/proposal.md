# add-fab-release-gate: Proposal

## Why

A design that passes ERC/DRC can still be unorderable: unrouted nets, BOM rows without MPNs, a PCB that no longer matches its schematic, stale or missing gerbers. Today nothing between "check is green" and "send to fab" is verified, so the last mile before spending money is exactly the part copperhead does not gate. The ecosystem has validated this check list (kicad-happy's release gate is the reference); implementing it as a deterministic extension of `check` is the highest-value capability gap on the roadmap (Phase 2, item 1).

## What Changes

- **`copperhead check --fab`**: an opt-in superset of `check` that runs the standard ERC + DRC + drift + constraint checks, then a fabrication release gate:
  - **Routing completeness**: zero unconnected items / airwires in the DRC report; explicit failure listing each unrouted net.
  - **BOM readiness**: every BOM.md row has a value, footprint, MPN, and rationale; rows still flagged `UNVERIFIED` are reported (warning by default, failure with `--strict`).
  - **Schematic-to-PCB match**: refdes, footprint, pad-number, and pad-net parity between `.kicad_sch` and `.kicad_pcb`; differences are named and malformed files fail closed.
  - **Output freshness**: gerber/drill package exists and is not stale (content hashes of the source `.kicad_pcb` recorded at export time match current state); missing or stale outputs fail with a one-line regeneration hint.
  - **Documentation presence**: LAYOUT.md has a filled `## Draft quality` section and DEVPLAN.md exists when the repo was produced by `create`.
- The gate is **contractually LLM-free and network-free**, same as the rest of `check` (AC-2.1's network guard extends to `--fab`), so it is safe in CI and pre-commit.
- `--json` output gains a stable `fab` section with per-check results.
- `export_outputs` enforces the strict gate before creating output directories or invoking KiCad exporters; `check --fab` remains a read-only inspection surface.

## Capabilities

### New Capabilities

- `fab-release-gate`: the `check --fab` check list (routing completeness, BOM readiness, schematic-to-PCB match, output freshness, documentation presence), its severity model (`--strict`), and its JSON report shape.

### Modified Capabilities

- `cli-surface`: `check` gains the `--fab` and `--strict` flags; the "deterministic and LLM-free" requirement extends verbatim to the fab gate; `--json` gains the `fab` key.

## Impact

- **Code**: new `src/kicad/fab.ts` (gate checks over existing sexp reader + DRC report normalizer); `src/commands/check.ts` gains flag wiring and report sections; export stage records source-content hashes into `.copperhead/config.json` for freshness checking.
- **Specs**: SPEC.md `check` section and AC-2 gain fab-gate criteria on archive.
- **Tests**: fixture variants (unrouted net, MPN-less BOM row, sch/pcb mismatch, stale gerbers) in the offline suite; network guard asserted for `--fab` runs.
- **Dependencies**: none new; reuses `kicad-cli` DRC JSON and the read-only s-expression parser.
- **Unchanged contracts**: plain `check` behavior is byte-identical when `--fab` is absent; spec-gating is untouched.

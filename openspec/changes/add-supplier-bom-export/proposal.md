# add-supplier-bom-export: Proposal

## Why

`create` stage 6 produces a generic `BOM.csv`, but no supplier accepts it as-is: JLCPCB wants its assembly format, DigiKey and Mouser want cart-uploadable part lists with quantities. Users close that gap by hand today, which is exactly the distance between "orderable BOM" (the current claim) and an order. Roadmap Phase 2, item 2: small lift, immediate practical payoff.

## What Changes

- **New command: `copperhead export bom`** with `--supplier <jlcpcb|digikey|mouser>`, `--boards <n>` (default 1), and `--spares <percent>` (default 10):
  - **JLCPCB**: assembly-service CSV (Comment, Designator, Footprint, LCSC Part # when known) plus the matching pick-and-place columns note.
  - **DigiKey / Mouser**: cart-upload CSV (MPN, manufacturer, quantity, customer reference) with quantities computed as `ceil(per-board count × boards × (1 + spares))`.
- Source of truth is **BOM.md** (already drift-checked against the schematic), so exports inherit the existing consistency guarantee; rows flagged `UNVERIFIED` or missing an MPN are listed in a warnings footer and excluded from supplier files unless `--include-unverified` is passed.
- `create` stage 6 SHALL additionally emit the JLCPCB file alongside the existing outputs package.
- Deterministic, LLM-free, network-free: pure transformation of repo state, safe anywhere `check` is safe.

## Capabilities

### New Capabilities

- `supplier-bom-export`: the `export bom` command, per-supplier file formats, quantity arithmetic (boards + spares), and the `UNVERIFIED`/missing-MPN exclusion rules.

### Modified Capabilities

- `cli-surface`: the CLI gains the `export bom` command with its flags.
- `create-pipeline`: stage 6 outputs additionally include the JLCPCB-format BOM.

## Impact

- **Code**: new `src/commands/export.ts` and `src/kicad/bom-export.ts` (BOM.md table parser already exists in drift checking; reuse it); create stage 6 gains one call.
- **Tests**: golden-file tests per supplier format from the fixture BOM; quantity arithmetic unit tests; warnings-footer and exclusion tests.
- **Dependencies**: none new (CSV emission is trivial string work; no network).
- **Unchanged contracts**: `check` untouched; agent loop untouched; BOM.md remains the human-readable source of truth.

Related create completion/export follow-up: [fix-create-stage-evidence](../fix-create-stage-evidence/proposal.md).

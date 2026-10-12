# add-supplier-bom-export: Design

## Context

BOM.md is the drift-checked, human-readable bill of materials; `create` stage 6 already exports a generic `BOM.csv` from it. Suppliers each want their own shape: JLCPCB's assembly CSV keys on LCSC part numbers and designator grouping, DigiKey and Mouser cart uploads key on MPN and quantity. The drift checker already contains a BOM.md table parser; this change is mostly formatting and arithmetic on top of trusted input.

## Goals / Non-Goals

**Goals:**

- One command that turns a green BOM.md into files a supplier accepts without editing.
- Quantity arithmetic (boards, spares) done once, correctly, with tests.
- Honest handling of rows that cannot be ordered (`UNVERIFIED`, missing MPN).

**Non-Goals:**

- No live pricing, stock, or part validation: that is `add-part-research-tools` territory and would break the network-free property of export.
- No pick-and-place / CPL file generation in this change (kicad-cli can produce placement data; wiring it in is a follow-up once the assembly flow is proven).
- No supplier API ordering.

## Decisions

- **D1: BOM.md is the input, not the schematic.** The schematic lacks MPNs and sourcing flags; BOM.md carries them and is already guaranteed consistent with the schematic by drift checking. Exporting from BOM.md means one parser (reused from `src/memory/drift.ts`) and inherits the consistency guarantee. Alternative: parse the schematic directly — rejected, it would duplicate the MPN source of truth.
- **D2: `export bom` is a new top-level command, not a `check` flag.** Export writes files; `check` must never write. Keeping the read-only/write split at the command boundary preserves the "check is safe anywhere" contract. Alternative: fold into `create` only — rejected; `do`-driven and hand-maintained repos need ordering files too.
- **D3: Unorderable rows are excluded and reported, not silently included.** A supplier CSV row without a valid MPN causes a cart error at upload time, in the supplier's UI, far from the tool. Failing loudly at export keeps the feedback local. `--include-unverified` exists because prototype orders legitimately include best-guess parts.
- **D4: Spares are percentage-based with a per-line minimum of +2 for passives.** `ceil(qty × boards × (1 + spares/100))`, then `max(result, qty × boards + 2)` for parts in passive footprint classes: losing two 0402s to tweezers is the norm, and percentage-only spares under-order on low-count lines. The classifier is footprint-prefix based (`R_`, `C_`, `L_`) and documented.
- **D5: Formats are golden-file tested, version-stamped, and centralized.** Each supplier format lives in one emitter function with a captured golden output in the test suite; when a supplier changes their template, the fix is one function and one golden file.

## Risks / Trade-offs

- [Supplier format churn] → golden files make the break visible in CI the moment we update them; formats are isolated per-emitter, so one supplier changing does not touch the others.
- [LCSC part numbers are often absent for JLCPCB assembly] → the column is emitted when a `LCSC` column exists in BOM.md, else left blank with a footer note; blank LCSC is accepted by JLCPCB's upload with manual matching.
- [Quantity heuristics wrong for a user's process] → both knobs (`--boards`, `--spares`) are explicit flags; the passive minimum is documented in the README and the warnings footer states computed quantities.

## Migration Plan

Purely additive command; stage 6 gains one extra output file. No rollback concerns beyond removing the command.

## Open Questions

- Whether to add a `LCSC` column to the BOM.md scaffold by default (helps JLCPCB flow, widens the table); leaning yes, decided at implementation with the scaffold owner.

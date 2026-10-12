# Tasks: add-supplier-bom-export

## 1. Export core

- [x] 1.1 Extract the BOM.md table parser from `src/memory/drift.ts` into a shared module and reuse it — `parseMarkdownTables` is now imported by `src/kicad/bom-export.ts`'s header-aware `parseBom`
- [x] 1.2 Implement quantity arithmetic (`ceil(qty × boards × (1 + spares/100))`, passive minimum `qty × boards + 2` for `R_`/`C_`/`L_` footprint prefixes) with unit tests — `orderQuantity` (float-dust-safe) + `isPassiveFootprint`
- [x] 1.3 Implement per-supplier emitters in `src/kicad/bom-export.ts`: JLCPCB assembly CSV, DigiKey cart CSV, Mouser cart CSV, each as one function
- [x] 1.4 Implement exclusion rules: MPN-less rows always excluded, `UNVERIFIED` rows excluded unless `--include-unverified`; warnings footer to stderr (CSV comments omitted — strict supplier upload formats reject comment lines, so the footer stays on stderr and in `--json`)

## 2. CLI wiring

- [x] 2.1 Add `src/commands/export.ts` with `export bom --supplier --boards --spares --include-unverified`; validate supplier values with a helpful error
- [x] 2.2 Refuse export with a drift hint when the parsed BOM.md disagrees with the schematic parse
- [x] 2.3 Wire the JLCPCB emitter into `create` stage 6 outputs — `emitCreateJlcpcbBom`, called whenever the outputs stage is confirmed complete

## 3. Tests

- [x] 3.1 Golden-file tests per supplier format against the fixture BOM
- [x] 3.2 Exclusion and `--include-unverified` behavior tests
- [x] 3.3 Drift-refusal test (edited BOM.md value → non-zero exit, drift hint)
- [x] 3.4 Network guard: no api.* connections during export (global `fetch` spy asserts zero calls)

## 4. Docs

- [x] 4.1 README: ordering section (`export bom` usage, quantity knobs, what gets excluded and why)
- [x] 4.2 Decide and document the optional `LCSC` column in the BOM.md scaffold (design open question) — decision: keep `init` scaffolding the base columns only; the exporter matches `Manufacturer`/`LCSC` by header when present, documented in the README ordering section. Leaves the scaffold table narrow while letting hand/agent-maintained BOMs opt in.

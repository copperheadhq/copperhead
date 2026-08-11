# networked-part-verification — Delta Spec

## ADDED Requirements

### Requirement: Networked part verification
`copperhead verify-parts` SHALL read `docs/BOM.md` and query the JLC/LCSC catalog API (`https://jlcsearch.tscircuit.com/api/search`) to verify that each orderable MPN exists and report its stock status.

#### Scenario: Verification report
- **WHEN** `verify-parts` runs on a BOM with a mixture of resolved, out-of-stock, and missing parts
- **THEN** it prints a tabular summary to stdout and exits 1 if any part is NOT FOUND.

### Requirement: Update resolved LCSC codes
When `--update` is passed to `verify-parts`, it SHALL overwrite resolved LCSC part codes back into the `LCSC` column of `docs/BOM.md` while preserving other columns and table layout structure.

#### Scenario: Update BOM table
- **WHEN** `verify-parts --update` runs and finds a resolved part
- **THEN** it writes its LCSC part code (e.g. `C25804`) back to the table on disk.

### Requirement: Strict mode fails on no stock
When `--strict` is passed to `verify-parts`, the run SHALL fail (exiting with 1) if any verified part is out of stock (`NO STOCK`) or fails lookup.

#### Scenario: Strict mode fails on no stock
- **WHEN** `verify-parts --strict` runs on a BOM containing a part with 0 stock
- **THEN** the command exits with code 1.

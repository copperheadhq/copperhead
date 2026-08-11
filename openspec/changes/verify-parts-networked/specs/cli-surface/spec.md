# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: CLI surface for part verification
The CLI SHALL expose the `verify-parts` command with `--update` and `--strict` options, and SHALL expose the `--verify` option on `export bom`.

#### Scenario: export bom --verify fails on lookup errors
- **WHEN** `export bom --supplier jlcpcb --verify` runs on a BOM with invalid MPNs
- **THEN** it aborts the export and exits 1.

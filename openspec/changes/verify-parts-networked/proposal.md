# verify-parts-networked: Proposal

## Why

Currently, `copperhead export bom` produces supplier-format CSVs, but nothing verifies that the Manufacturer Part Numbers (MPNs) actually exist or are orderable. The current check is purely a self-attestation that the part does not have the token `UNVERIFIED` and has a non-placeholder MPN in `BOM.md`. Typo'd or fake parts can pass this check, only to fail or be silently dropped at the supplier side.

Because of the network-free invariant, `check` and `export bom` cannot hit the network to verify parts. Therefore, we need an opt-in, explicitly networked verification command (`copperhead verify-parts`) to query distributor/catalog APIs, validate MPNs, report their real status (e.g., RESOLVED, NOT FOUND, NO STOCK), and optionally write back resolved LCSC part numbers to `BOM.md`.

## What Changes

- **New CLI Command: `copperhead verify-parts`**
  - Opt-in command that is allowed to hit the network to query parts.
  - Parses the user's `docs/BOM.md` file using the existing markdown table parser.
  - For each non-empty MPN, queries the `jlcsearch` API (`https://jlcsearch.tscircuit.com/api/search?q=<MPN>`).
  - Resolves part details:
    - **`RESOLVED`**: The part exists in the catalog and has stock > 0.
    - **`NO STOCK`**: The part exists but its stock is 0.
    - **`NOT FOUND`**: The part is not found in the catalog.
  - Prints a tabular summary of the parts and their resolved status to `stdout`.
  - Exits with `0` if all MPNs are resolved, or `1` if any part is not found or out of stock (under strict mode).
  - **Optional `--update` flag**: Updates `docs/BOM.md` with resolved LCSC part numbers (prefixed with `C`) if the `LCSC` column is present and the part is resolved.
- **New Command Flag: `copperhead export bom --verify`**
  - Runs `verify-parts` checks inline before exporting. If any part fails verification, the export fails.
- All core commands (`check`, plain `export bom`) remain strictly network-free.

## Capabilities

### New Capabilities

- `networked-part-verification`: The `verify-parts` command, catalog query logic (handling `RESOLVED`, `NO STOCK`, `NOT FOUND` statuses), tabular reporter, and `--update` modification of `BOM.md`.

### Modified Capabilities

- `cli-surface`: The CLI gains the `verify-parts` command and the `export bom --verify` flag.

## Impact

- **Code**: New `src/commands/verify.ts` to orchestrate verification; new `src/kicad/catalog.ts` to query the search API and parse LCSC component listings.
- **Tests**: Mocked network tests using Vitest's `vi.spyOn(global, 'fetch')` to ensure queries are handled properly and the offline/no-network invariant is maintained for normal commands.
- **Dependencies**: No new external npm packages; uses standard `fetch` which is built into Node.js 20+.
- **Unchanged contracts**: `check` remains completely network-free and unmodified.

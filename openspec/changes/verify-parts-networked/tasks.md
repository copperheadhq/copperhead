# Tasks: verify-parts-networked

## 1. Catalog Lookup Component

- [x] 1.1 Create `src/kicad/catalog.ts` and implement `queryPartCatalog` using standard `fetch`.
- [x] 1.2 Implement case-insensitive exact matching logic in `verifyMpn`.
- [x] 1.3 Map component lists to target `RESOLVED` / `NO STOCK` / `NOT FOUND` statuses.

## 2. Verify Command Implementation

- [x] 2.1 Create `src/commands/verify.ts` and implement `runVerifyParts` to parse `docs/BOM.md` and query the catalog.
- [x] 2.2 Add update logic to rewrite `BOM.md` with resolved LCSC part numbers if `--update` is specified.
- [x] 2.3 Add strict-mode evaluation (failing if any part is out of stock).
- [x] 2.4 Format the output as a tabular report on `stdout`.

## 3. CLI Command Wiring

- [x] 3.1 Register the `verify-parts` command in `src/cli.ts` with `--update` and `--strict` options.
- [x] 3.2 Add the `--verify` option to the `export bom` command, executing verification before export when passed.

## 4. Test Suite

- [x] 4.1 Create `test/verify.test.ts` to test the verification logic.
- [x] 4.2 Add unit tests for `verifyMpn` with mocked network responses.
- [x] 4.3 Add integration tests for `runVerifyParts` verifying the `--update` and `--strict` behaviors.
- [x] 4.4 Add a network invariant test asserting that calling `check` or plain `export bom` executes zero network requests.

## 5. Documentation Updates

- [x] 5.1 Document the new `verify-parts` command and `export bom --verify` flag in the project's README.

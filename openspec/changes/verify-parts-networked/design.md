# verify-parts-networked: Design

This change implements `copperhead verify-parts` to check the validity of Manufacturer Part Numbers (MPNs) from `docs/BOM.md` against the real JLC/LCSC component catalog.

## Technical Design

### 1. Catalog Lookup Component (`src/kicad/catalog.ts`)

We will query the public `jlcsearch` API provided by tscircuit, which aggregates search results for LCSC/JLCPCB parts.

#### Data Models
```typescript
export interface CatalogComponent {
  lcsc: number; // e.g. 2913202
  mfr: string; // e.g. "ESP32-S3-WROOM-1-N16R8"
  package: string;
  stock: number;
  price: number;
}

export interface CatalogItem {
  lcscCode: string; // e.g. "C2913202"
  mfr: string;
  package: string;
  stock: number;
  price: number;
}

export type MpnStatus = 'RESOLVED' | 'NO STOCK' | 'NOT FOUND';

export interface VerificationResult {
  refdes: string;
  mpn: string;
  status: MpnStatus;
  lcscCode?: string;
}
```

#### Functions
- `queryPartCatalog(mpn: string): Promise<CatalogItem[]>`:
  Fetches `https://jlcsearch.tscircuit.com/api/search?q=${encodeURIComponent(mpn)}` and maps the results.
- `verifyMpn(mpn: string): Promise<{ status: MpnStatus; item?: CatalogItem }>`:
  Queries the catalog for the MPN. It matches the queried MPN against `mfr` case-insensitively. If there is a match:
  - If `stock > 0`, returns `{ status: 'RESOLVED', item }`.
  - If `stock === 0`, returns `{ status: 'NO STOCK', item }`.
  - Otherwise, returns `{ status: 'NOT FOUND' }`.

### 2. Verify Command (`src/commands/verify.ts`)

- `runVerifyParts(repoRoot: string, opts: { update?: boolean; strict?: boolean }): Promise<{ ok: boolean; results: VerificationResult[] }>`:
  1. Locates `docs/BOM.md`.
  2. Parses the BOM table using `parseBom` from `src/kicad/bom-export.ts`.
  3. Filters unique MPNs to avoid redundant network requests.
  4. For each MPN, runs `verifyMpn`.
  5. Formats the results into a console table.
  6. If `opts.update` is true:
     - Updates `BOM.md` by finding each row for the matching MPN and replacing/updating the `LCSC` column value with the resolved `lcscCode` (if the `LCSC` column header is present in the table).
     - Writes the updated `BOM.md` back to disk.
  7. Returns `{ ok, results }`. The run is `ok` if:
     - In normal mode: no parts are `NOT FOUND`.
     - In strict mode (`--strict`): no parts are `NOT FOUND` or `NO STOCK`.

### 3. CLI Updates (`src/cli.ts`)

- **New Command**:
  ```typescript
  program
    .command('verify-parts')
    .description('verify BOM MPNs against LCSC distributor catalog')
    .option('--update', 'write resolved LCSC part numbers back to BOM.md')
    .option('--strict', 'fail if any part is out of stock')
    .action(async (opts) => { ... });
  ```
- **Modified `export bom` Command**:
  Adds `--verify` flag. If passed:
  - Runs `runVerifyParts(repo, { strict: false })` first.
  - If verification is not `ok`, exits with code `1` and does not write any CSV files.

## Invariant Protection

- **Network-Free Isolation**:
  The new command `verify-parts` is explicitly documented as a networked check.
  `runCheck` (the offline `copperhead check`) and plain `export bom` do NOT import `src/kicad/catalog` or call any network fetchers, maintaining the strict offline/CI-safe invariants verbatim.

### 4. Relationship to `add-part-research-tools`

This change introduces opt-in, non-LLM, catalog existence/stock verification (`copperhead verify-parts` and `copperhead export bom --verify`).
The planned `add-part-research-tools` change defines the broader part research and datasheet intake agent tools. The networked lookup surface established here (`jlcsearch` catalog lookup) acts as a read-only catalog query helper for BOM verification while maintaining strict offline invariants for standard `check` and `export bom` operations.

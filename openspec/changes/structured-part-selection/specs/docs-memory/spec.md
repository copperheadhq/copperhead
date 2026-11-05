# docs-memory — Delta Spec

## ADDED Requirements

### Requirement: BOM.md is rendered from the parts manifest

When `docs/parts.intent.json` exists, BOM.md SHALL be the deterministic render of it: the canonical `| Refdes | Value | Footprint | MPN | Rationale |` table extended with a `Symbol` column, a header line naming the manifest as the source, off-board rows marked `(off-board)` in the Footprint cell, no-part rows marked `(no part)` in the MPN cell, unverified MPNs suffixed `(UNVERIFIED)`, and a `## Substitutions` section when the manifest lists any. The render SHALL be readable by the existing BOM.md readers (drift, `export bom`, `explain`, the IR cross-check) with the same refdes, value and footprint results as a hand-written table. Rendering the same manifest twice SHALL produce byte-identical output.

#### Scenario: Existing readers see the same rows

- **WHEN** a manifest renders BOM.md
- **THEN** `parseBomTable` returns one row per entry with the rendered value and footprint, and an off-board row reports no footprint rather than a missing one

#### Scenario: Render is stable

- **WHEN** `draft_bom` renders an unchanged manifest a second time
- **THEN** BOM.md is byte-identical to the first render

### Requirement: Drift covers manifest-to-BOM.md agreement

When a manifest exists, the drift check SHALL compare BOM.md with the manifest's render and report a mismatch naming BOM.md and the manifest, in addition to the existing BOM.md-to-schematic comparisons. `check` SHALL report it without an LLM or network call. Without a manifest the drift check is unchanged.

#### Scenario: Hand edit to the rendered file is drift

- **WHEN** a user edits a Value cell in a rendered BOM.md
- **THEN** `check` reports BOM.md as differing from its manifest render and names the refdes

#### Scenario: A manifest that does not parse is drift

- **WHEN** `docs/parts.intent.json` exists but is not a valid manifest
- **THEN** `check` reports `parts.intent.json` as not a valid parts manifest, with the reason, instead of passing against the BOM.md on disk

### Requirement: The supplier export reads the rendered BOM as parts only

`export bom` SHALL read parts only from BOM.md tables that carry a Refdes header, so a rendered Substitutions table (or any supporting table) contributes no order line. The exported part number SHALL be the MPN cell without its `(UNVERIFIED)` annotation, with the row still treated as unverified. A row whose MPN cell is the no-part marker `(no part)` SHALL appear in no export and raise no warning. A row whose Footprint cell is `(off-board)` SHALL be included in distributor cart exports and excluded from the JLCPCB assembly export with a notice.

#### Scenario: Substitutions are not order lines

- **WHEN** a manifest with one substitution is rendered and exported for any supplier
- **THEN** the export holds one line per orderable part and no line taken from the Substitutions table

#### Scenario: Unverified part exports its bare MPN

- **WHEN** a rendered row reads `MCU8-SOIC (UNVERIFIED)` and the export runs with `--include-unverified`
- **THEN** the supplier file's part-number column holds `MCU8-SOIC`, and the warnings name the row as included but unverified

#### Scenario: Off-board part is bought, not assembled

- **WHEN** a rendered BOM holds a verified off-board battery `BT1`
- **THEN** the DigiKey and Mouser exports include `BT1` and the JLCPCB assembly export omits it and says so

#### Scenario: Board feature is on no order

- **WHEN** a rendered BOM holds a no-part mounting hole `H1`
- **THEN** no supplier export contains `H1` and no warning asks for its MPN

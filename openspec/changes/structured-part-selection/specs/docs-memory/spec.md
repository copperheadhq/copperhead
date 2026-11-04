# docs-memory — Delta Spec

## ADDED Requirements

### Requirement: BOM.md is rendered from the parts manifest

When `docs/parts.intent.json` exists, BOM.md SHALL be the deterministic render of it: the canonical `| Refdes | Value | Footprint | MPN | Rationale |` table extended with a `Symbol` column, a header line naming the manifest as the source, off-board rows marked `(off-board)` in the Footprint cell, unverified MPNs suffixed `(UNVERIFIED)`, and a `## Substitutions` section when the manifest lists any. The render SHALL be readable by the existing BOM.md readers (drift, `export bom`, `explain`, the IR cross-check) with the same refdes, value and footprint results as a hand-written table. Rendering the same manifest twice SHALL produce byte-identical output.

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

# agent-core — Delta Spec

## ADDED Requirements

### Requirement: `draft_bom` tool

The agent SHALL have a `draft_bom` tool that validates `docs/parts.intent.json` against the installed KiCad libraries and, when clean, renders BOM.md from it. It SHALL require the same edit unlock as `draft_schematic`. It MAY take the manifest's JSON text to write first, or run on the file as it is. It SHALL report every finding with the refdes it concerns and a concrete fix, SHALL expand passive entries from `package` to their canonical symbol and stock footprint, SHALL resolve each active entry's `libId` and `footprint`, SHALL check symbol pins against footprint pads, SHALL check every non-power entry names a SUBSYSTEMS.md heading and every heading has at least one entry, SHALL require a reason on each substitution, and SHALL exempt off-board entries from symbol, footprint and pad checks. A failed validation SHALL leave BOM.md untouched. The tool SHALL make no network call. An entry that sets `noPart` SHALL be exempt from the MPN rule only, and `noPart` together with an `mpn` or with `offBoard` SHALL be a finding.

#### Scenario: Clean manifest renders the BOM

- **WHEN** `draft_bom` runs on a manifest with no findings
- **THEN** BOM.md is written with one row per entry, a Symbol column, the UNVERIFIED flag on every unverified MPN, off-board rows marked, a Substitutions section when any exist, and the report says clean

#### Scenario: Findings name the refdes and the fix

- **WHEN** one entry's footprint is a one-digit slip of an installed id and another entry's value is prose
- **THEN** the report lists both refdes, the closest installed footprint ids for the first, and the value rule for the second, and BOM.md is not written

#### Scenario: Coverage gap is reported

- **WHEN** SUBSYSTEMS.md has a heading no manifest entry names as its group
- **THEN** the report names that heading as having no parts

#### Scenario: Invalid JSON is refused without writing

- **WHEN** the supplied manifest text is not valid JSON
- **THEN** the tool reports the parse error and writes neither the manifest nor BOM.md

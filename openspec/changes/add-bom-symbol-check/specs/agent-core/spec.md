# agent-core — Delta Spec

## ADDED Requirements

### Requirement: `check_bom_symbols` tool

The tool list SHALL include `check_bom_symbols`, requiring no unlock and mutating nothing. It SHALL audit every non-passive row of `docs/BOM.md` against the installed KiCad symbol libraries in one pass using `bomSymbolDossier` and return a summary header followed by the dossier lines.

#### Scenario: Missing symbol produces MISS header

- **WHEN** the agent calls `check_bom_symbols` and one or more BOM part groups match no installed KiCad symbol
- **THEN** the tool output begins with `MISS:` naming the count of missing part groups and instructing the caller to substitute an installed part before finishing part selection

#### Scenario: Unverified rows produce INCOMPLETE header

- **WHEN** the agent calls `check_bom_symbols` and no checked row is missing, but the dossier contains `NOT SEARCHED`, `NOT INCLUDED`, `UNRESOLVED`, or `pins unreadable`
- **THEN** the tool output begins with `INCOMPLETE:` (never `OK:`) and directs the caller to verify those rows with `search_symbols` and `symbol_pins`

#### Scenario: All rows matched produce candidate OK header

- **WHEN** the agent calls `check_bom_symbols` and every non-passive BOM part group has an installed candidate symbol with no incomplete disclosures
- **THEN** the tool output begins with `OK:` stating that every checked part has an installed candidate symbol and reminding the caller to confirm each top hit is the exact part (not a family member or bare die) with `symbol_pins`

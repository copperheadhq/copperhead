# kicad-tooling — Delta Spec

## ADDED Requirements

### Requirement: IR footprints match the BOM

Schematic IR validation SHALL refuse a part whose `footprint` differs from its BOM.md row's Footprint cell, naming both ids and instructing the agent to copy the BOM footprint rather than substitute another package. Cells SHALL be compared after dropping markdown backticks and spacing, never after case-folding.

With a footprint resolver, validation SHALL also refuse a symbol pin its footprint has no pad for, and a footprint pad no symbol pin names when the footprint's library ships a variant whose electrical pads are exactly the symbol's pins, naming the pins or pads, the footprint's pads and that variant. Pads unconnected by design SHALL be exempt: unnumbered, mechanical, shield and thermal pads by KiCad's naming (MP, SH, S1, EP, NC), a pad the library marks as a heatsink, and on a footprint named for an exposed pad (`-1EP`) the highest-numbered pad the symbol does not name. When the library ships no matching variant, the unnamed pads SHALL be reported in the draft's notes as the library's own pairing, not refused. The schematic stage's completion check SHALL validate with a resolver, so both checks run on resume as well as at draft time.

#### Scenario: Substituted package is refused

- **WHEN** the IR gives C1 `Capacitor_SMD:C_0402_1005Metric` and BOM.md gives `Capacitor_SMD:C_0603_1608Metric`
- **THEN** validation fails with a finding naming both ids

#### Scenario: Footprint pads without symbol pins are refused

- **WHEN** the draft tool validates a 6-pin power-only USB-C symbol paired with a 16-contact receptacle footprint
- **THEN** validation fails naming the pads no symbol pin covers (A1, A4, B1, B4, …), since they would float unconnected, and names the 6-contact receptacle in the same library whose pads match the symbol

#### Scenario: Mechanical pads are unconnected by design

- **WHEN** the footprint's only pads without a symbol pin are unnumbered, MP, SH, S1, EP or NC
- **THEN** validation passes

#### Scenario: An exposed pad the symbol does not name is unconnected by design

- **WHEN** the footprint's only pad without a symbol pin carries the library's heatsink property, or is the highest-numbered pad of a footprint named for an exposed pad (`DFN-8-1EP` pad 9 under the MCP73831 symbol)
- **THEN** validation passes

#### Scenario: A pairing the library ships no alternative to is noted, not refused

- **WHEN** a footprint has pads no symbol pin names and no footprint in its library has exactly the symbol's pins as its electrical pads (the FT232RL's SSOP-28, whose NC leads the symbol omits)
- **THEN** validation passes, and the draft report's notes name the pads as unconnected by the library's design, to confirm before fabrication

#### Scenario: The schematic stage's completion runs the pad checks

- **WHEN** `create` resumes on a schematic drafted against a footprint with pads no symbol pin covers
- **THEN** the schematic stage is not complete, and the run returns to it instead of populating a board

#### Scenario: Symbol pins without pads are refused

- **WHEN** the draft tool validates a part whose symbol pins are C/B/E and whose footprint's pads are 1/2/3
- **THEN** validation fails naming the pins and the footprint's pads, since those nets would vanish from the board

#### Scenario: Backtick styling is not a difference

- **WHEN** the BOM cell is the same id wrapped in backticks
- **THEN** validation passes

### Requirement: Project symbol libraries

Symbol resolution SHALL consult the project `sym-lib-table` beside the schematic (with `${KIPRJMOD}` expanded to that directory) before the stock symbol directories, skipping rows that point into copperhead's vendored cache. Symbols from a project library SHALL be read in place and SHALL NOT be copied into the vendored cache, so the user's row stays the library's source. Drafting SHALL keep every row a user added to `sym-lib-table` verbatim, whatever its layout, when it rewrites the vendored rows, and SHALL refuse to rewrite a table it cannot parse, leaving it unchanged.

#### Scenario: Project-only symbol library resolves

- **WHEN** a symbol's library is named only in the project `sym-lib-table` and no stock directory holds it
- **THEN** the symbol resolves from the project library

#### Scenario: User rows survive a draft

- **WHEN** the user added a row to `sym-lib-table` and the schematic is drafted again
- **THEN** the row is still present, alongside the vendored rows

#### Scenario: Multi-line rows survive a draft

- **WHEN** a user row spans several lines, or names its library unquoted
- **THEN** the row is still present byte for byte after the draft, and the table still parses

#### Scenario: An unreadable table is not rewritten

- **WHEN** the `sym-lib-table` is unbalanced
- **THEN** drafting fails naming the table, and the file is unchanged

#### Scenario: Project in a subfolder

- **WHEN** the schematic lives in `hardware/` and its library is named only in `hardware/sym-lib-table`
- **THEN** the symbol resolves from that library

#### Scenario: A used project library stays the source

- **WHEN** a draft uses one symbol from a project-only library, and a later draft uses another symbol from it
- **THEN** the user's row still points at the library after the first draft, and the second draft resolves

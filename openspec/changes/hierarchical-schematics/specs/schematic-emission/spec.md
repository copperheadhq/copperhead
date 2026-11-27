# schematic-emission: Delta Spec

## MODIFIED Requirements

### Requirement: Stable identifier derivation

Every UUID in emitted output SHALL be derived deterministically (UUIDv5) from a stable semantic path rooted in the project namespace and qualified by the owning sheet (for example `<sheet>/R1`, `<sheet>/R1/pin/2`, `<sheet>/wire/<net>/<index>`, `top/sheet/<group>`, `top/sheet/<group>/pin/<net>`), and elements SHALL be emitted in a canonical sort order (symbols by reference, wires by coordinates, sheet symbols by group order, sheet pins by side then name). Identical placement models SHALL yield byte-identical files, so regeneration produces empty git diffs. In hierarchical mode the guarantee holds per file: a change confined to one group's members SHALL re-emit only that group's child sheet, plus the top sheet only when the cross-group net set changed. Symbol `(instances …)` project paths SHALL derive from the top sheet's UUIDv5-stable identifier, so annotation data cannot vary between drafts.

#### Scenario: Byte-identical regeneration (AC-16.4)

- **WHEN** the same IR is drafted, committed, and drafted again
- **THEN** `git diff` over the schematic is empty

#### Scenario: Meaningful diffs

- **WHEN** one net is added to the IR and the sheet is re-drafted
- **THEN** the git diff touches only the elements whose placement or connectivity changed, not unrelated UUIDs

#### Scenario: Untouched sheets are byte-stable (AC-17.7)

- **WHEN** one group's in-group connections change in the IR and the hierarchy is re-drafted
- **THEN** only that group's child sheet differs; the top sheet and every other child sheet are byte-identical

## ADDED Requirements

### Requirement: Hierarchical file-set emission

The emitter SHALL emit hierarchical output as a file set: one top sheet and one file per child sheet, each produced through the same string-template mechanism with fixed section order, fixed indentation, and canonical number formatting. Sheet symbols, sheet pins, and hierarchical labels SHALL be emitted from templates with version-specific tokens confined to the emitter's template set. Tests SHALL parse the emitted hierarchy with the existing read-only parser and verify that connectivity resolved across sheet boundaries (hierarchical label to sheet pin to sibling sheet pin to hierarchical label) equals the IR's connection list, with no-connect pins excluded. A failed hierarchical draft SHALL leave every existing file of the previous draft untouched, never a partially updated file set.

#### Scenario: Emitted hierarchy connectivity matches intent (AC-17.8)

- **WHEN** a hierarchical reference IR is drafted and the file set is parsed from the root
- **THEN** the parser's inferred net list, resolved across sheet pins and hierarchical labels, equals the IR's connection list

#### Scenario: Failed draft leaves the file set intact

- **WHEN** a hierarchical draft fails validation or emission partway
- **THEN** every file of the previous draft is unchanged on disk

#### Scenario: Parser stays read-only

- **WHEN** the hierarchical emitter templates are built
- **THEN** they import no serialization capability from the parser and the parser exports none

# schematic-emission — Delta Spec

## ADDED Requirements

### Requirement: Canonical template emission

The emitter SHALL produce `.kicad_sch` text from the placement model through string templates with a fixed section order, fixed indentation, and KiCad's number formatting (trailing zeros trimmed). The emitter SHALL be a module separate from the s-expression parser, and the parser SHALL continue to never serialize.

#### Scenario: Canonical formatting

- **WHEN** the emitter writes a schematic
- **THEN** the file's section order, indentation, and number formatting are identical across runs and machines for the same placement model

#### Scenario: Parser stays read-only

- **WHEN** the emitter module is built
- **THEN** it imports no serialization capability from the parser and the parser exports none

### Requirement: Stable identifier derivation

Every UUID in emitted output SHALL be derived deterministically (UUIDv5) from a stable semantic path rooted in the project namespace (for example `sheet/R1`, `sheet/R1/pin/2`, `wire/<net>/<index>`), and elements SHALL be emitted in a canonical sort order (symbols by reference, wires by coordinates). Identical placement models SHALL yield byte-identical files, so regeneration produces empty git diffs.

#### Scenario: Byte-identical regeneration (AC-16.4)

- **WHEN** the same IR is drafted, committed, and drafted again
- **THEN** `git diff` over the schematic is empty

#### Scenario: Meaningful diffs

- **WHEN** one net is added to the IR and the sheet is re-drafted
- **THEN** the git diff touches only the elements whose placement or connectivity changed, not unrelated UUIDs

### Requirement: Hermetic vendored symbol sources

On first use of a library symbol, the engine SHALL vendor its `.kicad_sym` source text into the project (a committed symbol cache directory), and every subsequent draft SHALL read the vendored copy, not the installed library. The byte-identical regeneration guarantee is therefore scoped to the project, not to the machine's KiCad installation: a KiCad library upgrade SHALL NOT change drafted output until the vendored source is deliberately refreshed. Refreshing a vendored symbol SHALL be an explicit action whose diff is reviewable, and `verify_symbols` SHALL continue to compare against the installed libraries so genuine library drift stays visible rather than silently frozen.

#### Scenario: Library upgrade does not change output (AC-16.5)

- **WHEN** the installed KiCad symbol library changes after a symbol was vendored and the same IR is re-drafted
- **THEN** the drafted schematic is byte-identical to the pre-upgrade output, and `verify_symbols` reports the divergence between vendored and installed sources

#### Scenario: Vendoring is deterministic

- **WHEN** two machines with identical installed libraries first-draft the same IR
- **THEN** their vendored caches and drafted schematics are byte-identical

### Requirement: Verbatim lib_symbols embedding

The emitter SHALL embed each used library symbol by copying its `(symbol …)` s-expression text verbatim from the vendored source, altered only by the lib_id rename, never re-serializing library geometry.

#### Scenario: Library geometry is untouched

- **WHEN** a symbol is embedded into `lib_symbols`
- **THEN** its body text is byte-identical to the vendored source apart from the identifier line

### Requirement: Pinned format version

The emitter SHALL target a single KiCad format version, matching the version the project scaffold emits and the installed `kicad-cli` verifies, with version-specific tokens confined to the emitter's header template. Emitted files SHALL load cleanly in `kicad-cli` and pass ERC parsing on every CI run.

#### Scenario: Output loads in kicad-cli (AC-16.12)

- **WHEN** any golden IR is drafted in CI
- **THEN** `kicad-cli` loads the file without error and ERC runs to completion

### Requirement: Emitter output is cross-checked by the read-only parser

Tests SHALL parse emitter output with the existing read-only parser and verify that pin positions, symbol placements, and inferred nets match the IR that produced the file.

#### Scenario: Emitted connectivity matches intent (AC-16.13)

- **WHEN** a reference IR is drafted and the output is parsed
- **THEN** the parser's inferred net list equals the IR's connection list, with no-connect pins excluded

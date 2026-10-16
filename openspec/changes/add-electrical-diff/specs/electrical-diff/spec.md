# Electrical diff

## ADDED Requirements

### Requirement: Deterministic electrical revision review

The CLI SHALL provide `diff --base <revision>` with HEAD~1 as the default. It SHALL compare the working schematic with the requested local commit and report sorted component properties, pin-to-net changes, and named-net additions, removals, and inferred renames. Text SHALL start with `Electrical changes since <base>`; JSON SHALL include the requested base and resolved baseCommit.

#### Scenario: A value and net name change

- **WHEN** a real fixture's component value changes and a named net retains the same nonempty pin set under a new name
- **THEN** the report contains the component change and net rename, with supporting connection additions/removals

#### Scenario: Formatting and ordering

- **WHEN** only whitespace or source ordering changes
- **THEN** the report contains no electrical changes and changed reference lists always use natural numeric order

### Requirement: Complete contained schematic trees

The command SHALL materialize all transitively referenced sheets from each revision before parsing, preserve relative paths, normalize Windows separators, and reject repository escapes. It SHALL clean temporary copies and leave project files and the Git index unchanged, without provider or network calls.

#### Scenario: Historical child filenames

- **WHEN** a child or grandchild sheet has changed names since the baseline
- **THEN** both historical and current sheet trees are loaded independently and the electrical change is reported

#### Scenario: Missing baseline root

- **WHEN** the requested commit exists but the root schematic is new
- **THEN** the baseline is empty and the current components, connections, and named nets are additions

#### Scenario: Invalid base or missing child

- **WHEN** the revision cannot resolve or a referenced child is missing
- **THEN** the command fails with the revision or child path in an actionable error instead of a raw subprocess exception

#### Scenario: Traversal

- **WHEN** a configured path, sheet reference, or current symlink escapes the repo
- **THEN** comparison refuses before reading the outside schematic

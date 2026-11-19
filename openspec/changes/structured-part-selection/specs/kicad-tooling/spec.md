# kicad-tooling — Delta Spec

## ADDED Requirements

### Requirement: Library lookups are cached by file mtime

Symbol pin resolution and footprint resolution SHALL cache their results keyed by the library file's path and modification time, in process and in a JSON store under `.copperhead/cache/`, which SHALL be gitignored. A cached result SHALL be used only when the keyed mtime matches the file on disk. A missing, unreadable or corrupt cache store SHALL be ignored and rebuilt. The cache SHALL survive the agent loop's rollback of a failed run, so a retried stage does not re-parse unchanged libraries.

#### Scenario: Warm lookup skips the parse

- **WHEN** a symbol's pins were resolved earlier and its library file is unchanged
- **THEN** the second resolution returns the cached pins without reading the library file

#### Scenario: Changed library invalidates its entries

- **WHEN** a library file's mtime changes
- **THEN** every cached entry keyed to the old mtime is ignored and the file is parsed again

#### Scenario: Cache survives a rolled-back attempt

- **WHEN** a create stage attempt fails and the tree is restored to the run snapshot
- **THEN** the cache store under `.copperhead/cache/` is still present for the next attempt

# pattern-expansion — Delta Spec

## ADDED Requirements

### Requirement: Pure mechanical pattern expansion
The system SHALL provide a pure TypeScript helper function `expandPatternRef` that accepts a pattern identifier name and optional renaming/group parameters, loads the matching static circuit pattern definition from `src/kicad/patterns/<name>.json`, renumbers all component reference designators according to the requested options, rewrites all net endpoint pin connections to point to the renumbered references, and returns the expanded `{ parts: IntentPart[], nets: IntentNet[] }` data.

#### Scenario: Expanding voltage regulator pattern with prefix
- **WHEN** `expandPatternRef('voltage-regulator-ams1117', { refPrefix: 'PWR_' })` is invoked
- **THEN** it returns parts `PWR_U1`, `PWR_C1`, `PWR_C2` with their values/footprints preserved, and nets whose endpoints reference `PWR_U1.3`, `PWR_C1.1`, etc.

#### Scenario: Unknown pattern name throws descriptive error
- **WHEN** `expandPatternRef('non-existent-circuit')` is invoked
- **THEN** an Error is thrown stating that the pattern was not found in the patterns directory.

#### Scenario: Expanded parts and nets conform to SchematicIntent types
- **WHEN** a valid pattern is expanded
- **THEN** the returned parts and nets arrays can be merged into a `SchematicIntent` and validated without requiring any modification to `validateIntent`.

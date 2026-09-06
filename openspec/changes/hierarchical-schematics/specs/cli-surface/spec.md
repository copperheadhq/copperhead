# cli-surface: Delta Spec

## ADDED Requirements

### Requirement: Hierarchical results in CLI output

On a hierarchical design, `copperhead draft schematic` SHALL draft the full hierarchy and print a per-file report (files emitted, files unchanged, per-sheet findings and scores, the mode decision and its reason); `copperhead score schematic` SHALL print per-sheet composites and the aggregate; and `check --json`'s `legibility.score` object SHALL additively gain a `sheets` array of `{sheet, composite, metrics, cap}` records alongside the existing aggregate-shaped fields, with `sheets` containing one record for a flat design so consumers read one shape. All three surfaces SHALL remain LLM-free and network-free, and exit codes SHALL be unaffected by scores at any level.

#### Scenario: Per-sheet score JSON (AC-17.14)

- **WHEN** `check --json` runs on a hierarchical design
- **THEN** `legibility.score.sheets` lists each sheet's composite and breakdown, the top-level composite is the aggregate, and the exit code is unaffected

#### Scenario: Flat designs read as one sheet

- **WHEN** `check --json` runs on a flat design
- **THEN** `legibility.score.sheets` contains exactly one record whose composite equals the top-level composite

#### Scenario: Draft report states the file set

- **WHEN** `copperhead draft schematic` re-drafts a hierarchy after a one-group IR change
- **THEN** the printed report names the re-emitted files and the unchanged files, and the command makes no LLM or network call

# agent-core: Delta Spec

## ADDED Requirements

### Requirement: Sheet-scoped findings and drift paths

On a hierarchical design, every finding surface the agent sees SHALL name the sheet it came from: `check_legibility` results group findings per sheet, the `draft_schematic` report states what changed per emitted file and embeds per-sheet findings and scores, `score_schematic` returns per-sheet composites plus the aggregate, and the drift checker resolves and reports sheet-qualified paths so a BOM or PINOUT divergence names the sheet owning the part. The legibility ledger obligation SHALL track findings per sheet, so a commit of one clean sheet is possible while another sheet's obligation remains open, and stage-level `finish` still refuses while any sheet's error-severity findings are outstanding.

#### Scenario: Drift names the owning sheet (AC-17.13)

- **WHEN** the drift checker finds a BOM row diverging from a symbol on a child sheet
- **THEN** the finding carries the sheet-qualified path of the symbol, naming the child sheet

#### Scenario: Per-sheet obligations allow per-sheet commits

- **WHEN** one child sheet's findings are clean and its obligations closed while another sheet's error-severity findings remain
- **THEN** committing the clean sheet succeeds, and `finish` still lists the other sheet's findings as unmet obligations

#### Scenario: Draft report is per-file

- **WHEN** `draft_schematic` re-drafts a hierarchy where one group's IR changed
- **THEN** the report names the files re-emitted and the files left byte-identical, with findings and scores attributed per sheet

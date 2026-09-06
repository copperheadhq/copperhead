# schematic-hierarchy: Delta Spec

## ADDED Requirements

### Requirement: Deterministic hierarchical mode decision

The engine SHALL draft hierarchically when the IR's placed part count exceeds the configured threshold (`legibility.hierarchyThreshold`, with a documented default) or when `hints.hierarchy` is `"hierarchical"`; `hints.hierarchy: "flat"` SHALL force flat drafting regardless of size. The decision and its reason SHALL be stated in the draft report. Below the threshold and without a hint, flat drafting SHALL produce output byte-identical to the pre-hierarchy engine, so existing goldens pin the flat mode unchanged.

#### Scenario: Below the threshold nothing changes (AC-17.1)

- **WHEN** an IR below the threshold with no hierarchy hint is drafted
- **THEN** the output is a single flat sheet, byte-identical to the pre-hierarchy engine's output for the same IR

#### Scenario: Hint overrides the threshold (AC-17.2)

- **WHEN** an IR above the threshold declares `hints.hierarchy: "flat"`
- **THEN** the engine drafts a flat sheet and the draft report states the override

#### Scenario: The mode decision is reported

- **WHEN** any IR is drafted
- **THEN** the draft report states whether the output is flat or hierarchical and whether the threshold or a hint decided it

### Requirement: One child sheet per subsystem group

In hierarchical mode the engine SHALL emit one child sheet per SUBSYSTEMS.md group named by any placed part, at `<project>-<slug>.kicad_sch` where the slug derives from the group heading by the same deterministic token rule used for generated power-symbol names; two groups whose names sanitize to the same slug SHALL fail validation naming both. Each child sheet SHALL contain exactly the parts assigned to its group, drafted by the existing per-group pipeline (reductions, placement, wiring, alignment) with that group as the sheet's single captioned group. Each child sheet SHALL be instantiated exactly once, so reference designators remain globally unique and BOM and drift semantics are unchanged.

#### Scenario: Partition follows the IR groups (AC-17.3)

- **WHEN** an IR naming four groups is drafted hierarchically
- **THEN** four child sheets are emitted, each containing exactly its group's parts inside one captioned group box, plus the top sheet

#### Scenario: Colliding sheet slugs are refused

- **WHEN** two SUBSYSTEMS.md group names sanitize to the same file slug
- **THEN** validation fails naming both groups, before any placement runs

#### Scenario: Oversized group is refused with a named fix

- **WHEN** one group's banded content fits no standard sheet
- **THEN** validation fails naming the group and directing the user to split it in SUBSYSTEMS.md, and no file is written

### Requirement: Derived top sheet

In hierarchical mode the engine SHALL generate the top sheet: one sheet symbol per group, sized from its pin count, shelf-wrapped in the same group flow order as flat drafting; sheet pins derived from the cross-group net set, one pin per cross-group net reaching that group, side matching the child sheet's label stub side, ordered deterministically by side then name; short stub wires with net labels at each sheet pin so cross-group nets resolve through the top sheet under hierarchical ERC; and the populated title block. The top sheet SHALL contain no component symbols. Nets local to one group SHALL NOT appear on the top sheet.

#### Scenario: Top sheet is a block diagram (AC-17.4)

- **WHEN** an IR is drafted hierarchically
- **THEN** the top sheet contains one sheet symbol per group with pins exactly matching the cross-group net set, a filled title block, and no component symbols

#### Scenario: Local nets stay off the top sheet

- **WHEN** a net's endpoints all lie in one group
- **THEN** no sheet pin, stub, or label for that net appears on the top sheet

### Requirement: Hierarchy-wide ERC

ERC SHALL run once from the root sheet over the whole hierarchy via `kicad-cli`, which resolves hierarchical designs natively. Per-sheet ERC invocations SHALL NOT be used, since they would double-report cross-sheet nets. A hierarchical draft SHALL produce a hierarchy that `kicad-cli` loads without error.

#### Scenario: One ERC pass covers all sheets (AC-17.5)

- **WHEN** ERC runs on a hierarchically drafted project
- **THEN** a single `kicad-cli` invocation against the root sheet evaluates every child sheet, and cross-group connectivity produces no unconnected-pin violations

#### Scenario: Drafted hierarchy loads in kicad-cli

- **WHEN** any hierarchical golden IR is drafted in CI
- **THEN** `kicad-cli` loads the root sheet and its children without error and ERC runs to completion

# pcb-repair-loop — Delta Spec

## ADDED Requirements

### Requirement: Permitted and prohibited LLM actions
The model MAY classify nets and blocks, create and revise constraints, select engines and execution modes, choose routing order and strategies, decide what to preserve, interpret normalized failures, select from the repair catalog, and stop with `HOLD` or `REFUSE`. The model SHALL NOT emit track coordinates into production candidates, disable or lower hard constraints without explicit approval, edit source KiCad files outside the adapter, mark a candidate valid without verifier evidence, or retry beyond budget. These prohibitions SHALL be structural: no tool exists that could perform them.

#### Scenario: No copper-emitting tool exists (AC-17.10)
- **WHEN** the tool list for a layout run is enumerated
- **THEN** it contains no tool that accepts track or via geometry, and `edit_file` refuses `(segment`/`(via`/`(zone` replacements on a board under the framework

### Requirement: Repair catalog and budget
Repairs SHALL be chosen from the catalog of RFC §12.3 (change net priority, select another compatible router, change router configuration within approved limits, rip up named nets, move an unlocked group, expand or move a region, rotate an unlocked component, replace placement with another ranked candidate, request user action). The budget SHALL be engine-seconds and wall-clock; each action carries an estimated cost, a placement repair implying re-routing is charged for both, and an action exceeding the remaining budget SHALL NOT be selectable.

#### Scenario: Over-budget repair is unavailable
- **WHEN** 40 engine-seconds remain and the only repair estimates 60
- **THEN** the planner cannot select it and the run terminates `TIMEOUT` with the estimate recorded

### Requirement: Terminal statuses
Every run SHALL terminate with exactly one of `PASS`, `PARTIAL`, `HOLD`, `REFUSE`, `UNSUPPORTED`, `TIMEOUT`, `ENGINE_ERROR`, `INVALID_OUTPUT`, with the RFC §12.5 meanings, used identically by the CLI, the agent tools, `copperbench`, and the evidence bundle. `PARTIAL` SHALL list the remaining work explicitly.

#### Scenario: Statuses agree across surfaces
- **WHEN** the same snapshot is run through `copperhead pcb layout`, the `pcb_layout` tool, and a bench track
- **THEN** all three report the same status and the same evidence hashes

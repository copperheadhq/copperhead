# agent-core — Delta Spec

## ADDED Requirements

### Requirement: Framework tools
The tool list SHALL include `pcb_find_references` (searches datasheets, native-CAD designs, and teardowns for reference layouts matching the design's block anchors, caches them with license and provenance, and records approvals), `pcb_infer_intent` (runs the intent compiler and returns the constraint set with provenance and any `HOLD`s), `pcb_layout` (runs the closed loop under a profile and returns the status, ranking, and evidence bundle path), and `pcb_repair` (selects one catalog action against named diagnostics within the remaining budget). `pcb_layout` and `pcb_repair` SHALL be subject to spec-gating: structurally absent until the change proposal validates. No tool SHALL accept track or via geometry.

#### Scenario: Layout tool returns evidence (AC-17.17)
- **WHEN** the agent calls `pcb_layout`
- **THEN** the result names the status, every engine that ran, the selected candidate, unsatisfied constraints, and the bundle path, and the DRC obligation reflects the selected candidate's actual DRC

#### Scenario: Repair stays in the catalog
- **WHEN** the agent calls `pcb_repair` with an action outside the catalog
- **THEN** the call is refused listing the catalog

### Requirement: `do` on a framework board uses the repair loop
`copperhead do "<layout change>"` on a board with an evidence bundle SHALL treat the existing board as preserved geometry, express the change as constraints and repair actions, and re-verify; `edit_file` SHALL refuse `(segment`, `(via`, and `(zone` replacements on such a board and direct the agent to the framework tools. Boards without a bundle SHALL keep today's anchored `edit_file` path.

#### Scenario: Copper edit redirected
- **WHEN** the agent calls `edit_file` replacing a `(segment …)` on a board that has an evidence bundle
- **THEN** the call is refused naming `pcb_repair`, and no file change occurs

#### Scenario: Legacy boards unaffected
- **WHEN** `copperhead do` edits a board with no evidence bundle
- **THEN** `edit_file` behaves exactly as it does today

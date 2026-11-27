# pcb-scoring — Delta Spec

## ADDED Requirements

### Requirement: Metrics
Routing candidates SHALL be scored on PCBWorld's eight metrics unchanged, plus critical-net pass rate, bend and acute-angle count, layer-transition count, runtime, peak memory, and cross-seed variance. Placement candidates SHALL be scored on legality (gate), intent compliance weighted by priority, fixed-router clean-pass rate and completion (primary), post-route DRC count, congestion overflow, pin-aware critical attachment distance, weighted HPWL (secondary), and runtime and memory reported separately. Wirelength SHALL NOT be the dominant routability proxy.

#### Scenario: PCBWorld comparability (AC-17.9)
- **WHEN** a PCBWorld board is routed and scored
- **THEN** the eight metric values match the published protocol's definitions and the report names the benchmark version

### Requirement: Ranking policy
Ranking SHALL be lexicographic: every hard gate, then mandatory completion, then critical constraint compliance, then the selected optimization profile. Eligible candidates SHALL form a Pareto frontier; a weighted profile picks the default, and raw metrics and Pareto membership SHALL always be retained. Scores SHALL be comparable only within one benchmark version, fabrication profile, checker versions, and resource budget, and the report SHALL name all four.

#### Scenario: Profile picks, frontier retained
- **WHEN** three eligible candidates trade vias against wirelength
- **THEN** the report lists all three with Pareto membership and names the one the profile selected with its weighted score

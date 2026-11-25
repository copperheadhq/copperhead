# copperbench — Delta Spec

## ADDED Requirements

### Requirement: Tracks and datasets
`copperbench` SHALL run tracks E (intent compliance), D (repair), F (refusal), A (placement only), B (routing only, PCBWorld protocol unchanged), and C (end to end) over the datasets of RFC §13.2: curated microboards, reference boards, a PCBWorld subset, a Cypress subset where licensed, synthetic stress cases, refusal cases, and every production-discovered regression. It SHALL absorb the verification metrics of the foundation-model plan.

#### Scenario: Refusal track scores explicit status (AC-17.11)
- **WHEN** track F runs a board whose correct outcome is `HOLD`
- **THEN** the score counts a `HOLD` as correct, any other status as incorrect, and a `REFUSE` on a should-pass board as a false refusal

### Requirement: Experiment protocol and reproducibility
Each run SHALL use one canonical snapshot, fixed resources, pinned engine and adapter versions, and fixed seeds; outputs SHALL pass identical normalization and verification. Reports SHALL include raw per-board metrics, unsupported and failure counts, seed variance, upstream commit hashes, licenses, adopted-versus-built layers, and reproduction commands. Fixed-seed harness outputs SHALL be byte-identical across repeated runs, with engine variance reported separately.

#### Scenario: Harness is byte-stable (AC-17.12)
- **WHEN** the golden microcases run twice with the same seeds and engine versions
- **THEN** every harness metric and hash is identical and any engine-side difference appears only under seed variance

### Requirement: Milestones are the acceptance evidence
B0 through B4 (RFC §13.5) SHALL be recorded as bench reports; a milestone claim without its report SHALL NOT be made. Until the held-out set reaches 30 boards, B4 numbers SHALL be labelled directional.

#### Scenario: B1 selection correctness
- **WHEN** two routing engines run the 40 microboards and 20 PCBWorld boards
- **THEN** the report shows candidate-selection regret of zero against the evaluated oracle, an invalid-over-valid selection rate of zero, and measured orchestration overhead

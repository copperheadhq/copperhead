## MODIFIED Requirements

### Requirement: Tracks and datasets
`copperbench` SHALL run tracks E (intent compliance), D (repair), F (refusal), A (placement only), B (routing only, PCBWorld protocol unchanged), and C (end to end) over the datasets of RFC §13.2: curated microboards, reference boards, a PCBWorld subset, a Cypress subset where licensed, synthetic stress cases, refusal cases, and every production-discovered regression. It SHALL absorb the verification metrics of the foundation-model plan. The curated microboards SHALL include the multilayer cases (`four-layer`, `six-layer`, `via-span`) and the PCBench pool SHALL include a four-layer suite reported separately from the two-layer numbers (`pcb-multilayer`).

#### Scenario: Refusal track scores explicit status (AC-17.11)
- **WHEN** track F runs a board whose correct outcome is `HOLD`
- **THEN** the score counts a `HOLD` as correct, any other status as incorrect, and a `REFUSE` on a should-pass board as a false refusal

#### Scenario: Multilayer numbers never mix with two-layer numbers
- **WHEN** `pcbench-4layer` and `pcbench-qual` are both run
- **THEN** each report carries its own summary and neither suite's boards appear in the other's clean-pass rate

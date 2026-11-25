# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `pcb reuse` points at its records
`copperhead pcb reuse` SHALL print where placement.md is, and how many parts
the selected option, or the applied one, changes. With `--json` it SHALL
include placement.md's path and each option's count of changed parts.

#### Scenario: A run says what it would change
- **WHEN** `copperhead pcb reuse --reference ref.kicad_pcb` ends without
  `--apply`
- **THEN** it prints the path of placement.md and "selected option <id>
  changes <n> part(s); --apply writes it"

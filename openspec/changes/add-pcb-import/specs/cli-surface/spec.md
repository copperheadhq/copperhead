# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `pcb diff` compares boards
`copperhead pcb diff` SHALL accept, on either side, a `.kicad_pcb` file or a
board at a git revision written `<rev>:<path>`. It SHALL import each board into
a layout input, with identifiers derived under one project: the board file's
name, unless `--project` names another. It SHALL remain read-only, LLM-free,
and network-free.

#### Scenario: A board against its earlier revision
- **WHEN** `copperhead pcb diff HEAD:board.kicad_pcb board.kicad_pcb` runs
  after a part was moved and turned
- **THEN** the text view shows that part as one changed row with its distance
  and rotation, and the exit code is 0

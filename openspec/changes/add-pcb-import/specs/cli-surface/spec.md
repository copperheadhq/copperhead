# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `pcb diff` compares boards
`copperhead pcb diff` SHALL accept, on either side, a `.kicad_pcb` file or a
board at a git revision written `<rev>:<path>`. It SHALL import both boards
into layout inputs with identifiers derived under one project: the first
board's file name, unless `--project` names another. It SHALL print each
import's `lossy` notes on standard error, so that `--json` prints one placement
diff record. It SHALL remain read-only, LLM-free, and network-free.

#### Scenario: A board against its earlier revision
- **WHEN** `copperhead pcb diff HEAD:board.kicad_pcb board.kicad_pcb` runs
  after a part was moved and turned
- **THEN** the text view shows that part as one changed row with its distance
  and rotation, and the exit code is 0

#### Scenario: Two boards under different names
- **WHEN** `copperhead pcb diff old.kicad_pcb new.kicad_pcb` compares two
  files that differ only in one part's position
- **THEN** only that part is shown changed, and what the imports could not
  represent is printed on standard error as `note:` lines

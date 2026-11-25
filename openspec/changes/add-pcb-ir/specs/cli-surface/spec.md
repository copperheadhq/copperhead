# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `pcb diff` and `pcb textconv` commands
The CLI SHALL provide `copperhead pcb diff <before> <after>`, which prints the
text view of the placement diff of `<after>` relative to `<before>`. The before
side is a layout input. The after side is a candidate, whose block layouts are
read from `--blocks <dir>` or else from beside it, or a later layout input.
With `--json` the command SHALL print the placement diff record instead. Given
a `.kicad_pcb`, it SHALL exit 1 and say the board must first be imported into a
layout input.

The CLI SHALL also provide `copperhead pcb textconv <board>`, which prints the
board text of a `.kicad_pcb` for use as git's diff driver.

Both commands SHALL be deterministic, LLM-free, network-free, and read-only,
and SHALL NOT require `kicad-cli`.

#### Scenario: Diffing the RFC's candidate
- **WHEN** `copperhead pcb diff layout-input.ldo-board.json candidate.ldo-board.json`
  runs in the RFC examples directory
- **THEN** the first line is
  `diff 14fd4352 -> candidate b9974acb: 4 changed, 1 needs approval`, and the
  exit code is 0

#### Scenario: git diff through the driver
- **WHEN** a repository sets `*.kicad_pcb diff=copperhead-pcb` and
  `diff.copperhead-pcb.textconv` to `copperhead pcb textconv`, and one
  footprint moves
- **THEN** `git diff` shows that footprint's line removed and re-added with its
  new position and angle

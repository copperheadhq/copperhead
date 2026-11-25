# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `pcb` command group
`copperhead pcb import|infer-intent|place|route|verify|score|layout` SHALL expose the framework (RFC §13.5.2): `import` produces the IR and snapshot; `infer-intent` runs the intent compiler; `place` and `route` run named or all eligible engines in a chosen execution mode; `verify` checks one candidate; `score` ranks a run directory; `layout` runs the closed loop under a profile. Every command SHALL terminate with one of the eight statuses and SHALL write the evidence bundle. `import`, `verify`, and `score` SHALL make zero LLM or network calls; `infer-intent` and `layout` MAY call the model and SHALL say so in `--help`.

#### Scenario: Verify is offline (AC-17.13)
- **WHEN** `copperhead pcb verify candidate.kicad_pcb` runs under the network guard
- **THEN** it exits with the candidate's status, writes diagnostics, and opens no connection

### Requirement: `copperbench` binary
`copperbench run --track <track> --suite <suite>`, `compare <run-a> <run-b>`, and `report <dir>` SHALL implement the bench protocol and emit JSON and HTML reports.

#### Scenario: Compare two runs
- **WHEN** `copperbench compare` is given two run directories of the same benchmark version
- **THEN** it reports per-board metric deltas and refuses with a named reason when the versions differ

## MODIFIED Requirements

### Requirement: `check` is deterministic and LLM-free
`copperhead check` SHALL run ERC, DRC, and the doc-drift check, exit non-zero if any violation exists, and make zero LLM/network calls, completing in under 60 seconds on the test fixture. `copperhead verify` SHALL be an alias with identical behavior. When a board is under the framework (an evidence bundle exists for it), `check` SHALL additionally run the layout track: intent-constraint compliance and the supplementary checkers over the board as committed, reporting diagnostics without invoking any engine and without any LLM or network call; DRC's unconnected items SHALL be reported as completion, not as violations.

#### Scenario: verify alias
- **WHEN** `copperhead verify` is run
- **THEN** it behaves identically to `copperhead check`, and `--help` lists `verify` as an alias of `check`

#### Scenario: Clean fixture passes (AC-2.1, AC-2.5)
- **WHEN** `check` runs on a clean fixture repo
- **THEN** it exits 0, prints ERC ✓ DRC ✓ drift ✓, makes no network calls to any api.* host, and finishes in < 60 s

#### Scenario: Broken schematic fails with location (AC-2.2)
- **WHEN** `check` runs on a schematic with an unconnected pin
- **THEN** it exits non-zero and prints the violation with its sheet and location

#### Scenario: Layout track reports intent violations (AC-17.14)
- **WHEN** `check` runs on a repo whose board violates a hard registry constraint recorded with class `relative`
- **THEN** it exits non-zero naming the constraint, the measured and allowed values, and the refdes involved, having run no engine

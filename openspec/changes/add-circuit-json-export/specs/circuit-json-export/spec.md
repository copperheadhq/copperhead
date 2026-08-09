# circuit-json-export — Delta Spec

## ADDED Requirements

### Requirement: Derived circuit-json export of a drafted schematic
`copperhead export circuit-json [--out <path>]` SHALL serialize the drafted schematic to a tscircuit circuit-json document (default `outputs/circuit.json`) built from the on-disk intent IR and the draft engine's recomputed placement model: each intent part becomes a `source_component` with one `source_port` per resolved symbol pin, each intent net becomes a `source_net` and a `source_trace` connecting its ports, placed symbols become `schematic_component`/`schematic_port` elements, net wires become `schematic_trace` routes, and net labels become `schematic_net_label` elements. The export SHALL be deterministic (identical intent yields a byte-identical file), make zero LLM and zero network calls, and never modify any KiCad file.

#### Scenario: Export from a drafted fixture
- **WHEN** `export circuit-json` runs on a repo whose `.kicad_sch` was drafted from its `schematic.intent.json`
- **THEN** `outputs/circuit.json` is written, every element parses against the pinned `circuit-json` package's element schemas, and the set of `source_component` refdes values equals the intent's part refdes set

#### Scenario: Deterministic bytes
- **WHEN** `export circuit-json` runs twice on the same drafted repo
- **THEN** the two output files are byte-identical

#### Scenario: Connectivity carried faithfully
- **WHEN** the intent declares a net with pins `["U1.1", "R1.2"]`
- **THEN** the emitted `source_trace` for that net connects exactly the `source_port` elements for U1 pin 1 and R1 pin 2, and a pin listed in `noConnect` appears in no `source_trace`

### Requirement: Drafted-projects-only refusal
The export SHALL refuse, with a non-zero exit and an actionable message, when the intent file is absent (project not drafted by copperhead) or when re-drafting the intent does not reproduce the on-disk `.kicad_sch` byte-for-byte (hand-edited or stale sheet). The refusal SHALL name the file to fix and the supported path (draft/re-draft); it SHALL never fall back to lifting the `.kicad_sch`.

#### Scenario: No intent file
- **WHEN** `export circuit-json` runs in a repo with a `.kicad_sch` but no `schematic.intent.json`
- **THEN** the command exits non-zero and the message names `schematic.intent.json` and states that circuit-json export covers drafted schematics only

#### Scenario: Stale or hand-edited schematic
- **WHEN** the on-disk `.kicad_sch` differs from what re-drafting the intent emits
- **THEN** the command exits non-zero, tells the user to re-draft, and writes no output file

### Requirement: Read-only derived view
The circuit-json serializer SHALL be a pure function of the validated intent and placement model with no file I/O, SHALL NOT be reachable from any agent mutation tool, and this capability SHALL NOT add any parser or serializer to the KiCad mutation path (`sexp.ts` remains read-only and unchanged).

#### Scenario: No mutation-path coupling
- **WHEN** the agent tool list is built (with or without a validated proposal)
- **THEN** no tool exposes circuit-json serialization, and no KiCad file write path imports the serializer

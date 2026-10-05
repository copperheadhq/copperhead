# fab-release-gate — Delta Spec

## ADDED Requirements

### Requirement: Routing completeness check
`copperhead check --fab` SHALL fail when the DRC report contains any unconnected item, listing every unrouted net by name and location. The check SHALL reuse the DRC run already performed by `check`, not invoke `kicad-cli` a second time.

#### Scenario: Unrouted net fails the gate
- **WHEN** `check --fab` runs on a board whose DRC report contains one unconnected item on net `KEY_DAH`
- **THEN** the command exits non-zero and the report names `KEY_DAH` with its location under a routing-completeness failure

#### Scenario: Fully routed board passes
- **WHEN** `check --fab` runs on a board with zero unconnected items
- **THEN** the routing-completeness check reports pass

### Requirement: BOM readiness check
`check --fab` SHALL fail when any BOM.md row lacks a value, footprint, MPN, or rationale, naming each incomplete row by refdes. Rows flagged `UNVERIFIED` SHALL be reported as warnings by default and SHALL fail the gate only when `--strict` is passed. `export_outputs` SHALL always apply strict behavior.

#### Scenario: Missing MPN fails
- **WHEN** `check --fab` runs and BOM.md has a row for `R3` with an empty MPN column
- **THEN** the command exits non-zero and the report names `R3` under a BOM-readiness failure

#### Scenario: UNVERIFIED row warns by default
- **WHEN** `check --fab` runs and BOM.md has a row flagged `UNVERIFIED` but complete
- **THEN** the command reports a warning for that row and the warning alone does not cause a non-zero exit

#### Scenario: UNVERIFIED row fails under --strict
- **WHEN** `check --fab --strict` runs against the same BOM.md
- **THEN** the command exits non-zero citing the `UNVERIFIED` row

### Requirement: Schematic-to-PCB match check
`check --fab` SHALL compare refdes, footprint assignments, pad-number sets, and pad-net assignments between the `.kicad_sch` and `.kicad_pcb` using the read-only s-expression reader, and SHALL fail naming every mismatch. A PCB root-sheet net named `/NAME` SHALL match schematic net `NAME`, and a PCB-generated `unconnected-(...)` net SHALL match a schematic pin with no net. Hierarchical net paths SHALL remain significant. Malformed or truncated files SHALL fail closed. The comparison SHALL NOT regenerate or serialize either file.

#### Scenario: Component missing from board
- **WHEN** the schematic contains `D2` and the board does not
- **THEN** `check --fab` exits non-zero and reports `D2` as present in schematic, absent from PCB

#### Scenario: Footprint mismatch
- **WHEN** `R1` has footprint `R_0402` in the schematic and `R_0603` on the board
- **THEN** `check --fab` exits non-zero and reports both values for `R1`

#### Scenario: Equivalent KiCad net names match
- **WHEN** a schematic pin is on root-sheet net `USB_CC1` and its PCB pad is on `/USB_CC1`, or a schematic pin has no net and its PCB pad carries KiCad's generated `unconnected-(...)` name
- **THEN** the schematic-to-PCB check does not report either pad as a mismatch

#### Scenario: Hierarchical net paths remain distinct
- **WHEN** a schematic pin is on `/child/SIGNAL` and its PCB pad is on root-sheet net `/SIGNAL`
- **THEN** `check --fab` exits non-zero and reports the pad-net mismatch

### Requirement: Output freshness check
`check --fab` SHALL verify that the gerber and drill package exists and was exported from the current `.kicad_pcb`, by comparing a SHA-256 content hash of the board file recorded at export time against the current file. Missing outputs, a missing hash record, or a hash mismatch SHALL each fail with a one-line regeneration hint.

#### Scenario: Stale gerbers fail
- **WHEN** the board file has changed since the recorded export hash was written
- **THEN** `check --fab` exits non-zero, reports the outputs as stale, and prints the command to regenerate them

#### Scenario: Missing outputs fail
- **WHEN** no gerber/drill package exists in the configured output path
- **THEN** `check --fab` exits non-zero reporting the missing package

### Requirement: Export is verification-gated
`export_outputs` SHALL run fresh ERC and DRC and the strict fabrication checks before creating an output directory or invoking any manufacturing exporter. Provenance SHALL be written only after every exporter succeeds and Gerber and drill files exist.

#### Scenario: Failed preflight writes no outputs
- **WHEN** ERC, DRC, routing, BOM readiness, or schematic/PCB parity fails
- **THEN** no exporter is invoked and no new output directory or success provenance is written

#### Scenario: Stage completion requires current provenance
- **WHEN** the board hash changes or any recorded output disappears
- **THEN** the outputs stage is incomplete until a complete export regenerates the files and provenance

### Requirement: Documentation presence check
`check --fab` SHALL fail when LAYOUT.md lacks a filled `## Draft quality` section, and, for repos produced by `create`, when DEVPLAN.md is absent.

#### Scenario: Missing draft-quality section
- **WHEN** `check --fab` runs and LAYOUT.md has no `## Draft quality` section
- **THEN** the command exits non-zero naming LAYOUT.md and the missing section

### Requirement: Gate is deterministic, LLM-free, and network-free
`check --fab` SHALL make zero LLM and zero network calls, and SHALL complete within the same 60-second fixture budget as plain `check`.

#### Scenario: Network guard holds under --fab
- **WHEN** `check --fab` runs on the fixture with the test network guard active
- **THEN** no connection to any api.* host is attempted and the run completes in under 60 seconds

### Requirement: JSON report shape
With `--json`, the fab gate SHALL emit a stable `fab` object with keys `routing`, `bom`, `schPcbMatch`, `outputs`, and `docs`, each containing `status` (`pass`, `warn`, or `fail`) and a `violations` array of `{claim, actual, location?}` entries.

#### Scenario: Machine-readable fab section
- **WHEN** `check --fab --json` runs
- **THEN** stdout parses as JSON containing a `fab` object with exactly the five named keys, each with `status` and `violations`

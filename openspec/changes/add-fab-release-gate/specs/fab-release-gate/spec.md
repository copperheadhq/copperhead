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
`check --fab` SHALL fail when any BOM.md row lacks an MPN or a footprint, naming each incomplete row by refdes. Rows flagged `UNVERIFIED` SHALL be reported as warnings by default and SHALL fail the gate only when `--strict` is passed.

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
`check --fab` SHALL compare refdes and footprint assignments between the `.kicad_sch` and `.kicad_pcb` using the read-only s-expression reader, and SHALL fail naming every component present on only one side or carrying mismatched footprints. The comparison SHALL NOT regenerate or serialize either file.

#### Scenario: Component missing from board
- **WHEN** the schematic contains `D2` and the board does not
- **THEN** `check --fab` exits non-zero and reports `D2` as present in schematic, absent from PCB

#### Scenario: Footprint mismatch
- **WHEN** `R1` has footprint `R_0402` in the schematic and `R_0603` on the board
- **THEN** `check --fab` exits non-zero and reports both values for `R1`

### Requirement: Output freshness check
`check --fab` SHALL verify that the gerber and drill package exists and was exported from the current `.kicad_pcb`, by comparing a SHA-256 content hash of the board file recorded at export time against the current file. Missing outputs, a missing hash record, or a hash mismatch SHALL each fail with a one-line regeneration hint.

#### Scenario: Stale gerbers fail
- **WHEN** the board file has changed since the recorded export hash was written
- **THEN** `check --fab` exits non-zero, reports the outputs as stale, and prints the command to regenerate them

#### Scenario: Missing outputs fail
- **WHEN** no gerber/drill package exists in the configured output path
- **THEN** `check --fab` exits non-zero reporting the missing package

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

### Requirement: Manufacturing export is preflight-gated
The `export_outputs` tool SHALL run routing completeness, BOM readiness,
schematic-to-PCB match, and layout-documentation checks before invoking any
KiCad exporter. Its automated preflight SHALL use strict BOM readiness, so an
`UNVERIFIED` part blocks export even though an explicitly invoked non-strict
`check --fab` reports that condition as a warning. A failing preflight SHALL produce no new manufacturing files.
A successful export SHALL record the source-board content hash and generated
paths used by the output-freshness check.

#### Scenario: Draft board cannot become an output package
- **WHEN** `export_outputs` is requested for a DRC-clean board whose PCB
  footprint differs from the schematic assignment
- **THEN** export is refused before writing Gerbers and the mismatch is named

#### Scenario: Autonomous export refuses unverified parts
- **WHEN** `export_outputs` is requested while any BOM row remains `UNVERIFIED`
- **THEN** export is refused before invoking KiCad and the affected refdes is named

### Requirement: JSON report shape
With `--json`, the fab gate SHALL emit a stable `fab` object with keys `routing`, `bom`, `schPcbMatch`, `outputs`, and `docs`, each containing `status` (`pass`, `warn`, or `fail`) and a `violations` array of `{claim, actual, location?}` entries.

#### Scenario: Machine-readable fab section
- **WHEN** `check --fab --json` runs
- **THEN** stdout parses as JSON containing a `fab` object with exactly the five named keys, each with `status` and `violations`

# docs-memory: Delta Spec

## MODIFIED Requirements

### Requirement: `init` scaffolds docs from the real schematic
`copperhead init` SHALL detect the KiCad project, parse symbols/footprints/nets, and generate `docs/SPEC.md`, `BOM.md`, `PINOUT.md`, `SUBSYSTEMS.md`, `LAYOUT.md`, and `.copperhead/config.json` pre-filled with real extracted data, not placeholders. BOM.md SHALL omit DNP and `in_bom no` parts and keep a real MPN where the schematic carries one; a blank or placeholder MPN (`~`, `-`, `N/A`, `TBD`) SHALL stay UNVERIFIED, and a value holding `|` or a newline SHALL not shift the table columns. PINOUT.md SHALL list IC and connector pins by derived classification.

#### Scenario: Skeleton created (AC-1.1)
- **WHEN** `init` runs on a KiCad repo with no `docs/`
- **THEN** all five docs and `.copperhead/config.json` exist

#### Scenario: BOM reflects the schematic (AC-1.2)
- **WHEN** `init` completes
- **THEN** BOM.md contains one row per orderable schematic symbol with real refdes, value, and footprint, DNP and BOM-excluded symbols are absent, and a real MPN from the schematic is kept

#### Scenario: Pinout reflects the schematic (AC-1.3)
- **WHEN** `init` completes on a schematic containing an MCU, a connector, and a stock `Power_*` library IC
- **THEN** PINOUT.md contains their actual pin-to-net assignments, and no passive or LED pins

### Requirement: Drift check
`check_drift` SHALL compare the BOM.md and PINOUT.md tables against the parsed schematic and report each mismatch as `{ doc, claim, actual }`; any `do` run that changes a value referenced by a doc MUST update that doc in the same run. It SHALL NOT flag the absence of a DNP or BOM-excluded part from BOM.md, and SHALL flag a BOM.md row for a part the schematic marks DNP or BOM-excluded. The draft BOM cross-check SHALL likewise accept such a part with no BOM.md row.

#### Scenario: Doc disagrees with schematic (AC-2.3)
- **WHEN** a BOM.md value is edited to disagree with the schematic (e.g. wrong resistor value) and the drift check runs
- **THEN** it fails and names the doc, the claimed value, and the actual value

#### Scenario: Clean state
- **WHEN** docs and schematic agree
- **THEN** `check_drift` returns an empty list

#### Scenario: DNP part absent
- **WHEN** a DNP part has no BOM.md row
- **THEN** drift reports nothing for it

#### Scenario: DNP part still orderable
- **WHEN** BOM.md holds a row for a part now marked DNP
- **THEN** drift reports the row as orderable but excluded in the schematic

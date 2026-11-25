## ADDED Requirements

### Requirement: Schematic identity and pin metadata

The KiCad importer SHALL read, where the board file carries them:
- each footprint's `(path "...")` into `ComponentInstance.symbolPath`;
- each footprint's `(sheetname "...")` and `(sheetfile "...")` into `ComponentInstance.sheet`;
- each pad's `(pinfunction "...")` and `(pintype "...")` into `PadDefinition.pinFunction` and `PadDefinition.pinType`.

The fields SHALL be optional, and the canonical hash SHALL include them.

#### Scenario: Sheets and pin names import
- **WHEN** `multichannel_mixer.kicad_pcb` is imported
- **THEN** its channel parts carry sheet names `/CH1/` to `/CH4/`, every footprint with a path carries `symbolPath`, and pads with a pin function carry `pinFunction`

#### Scenario: Boards without the fields
- **WHEN** a golden microboard without paths, sheets or pin functions is imported
- **THEN** the fields are absent, and the board's existing canonical hash is unchanged

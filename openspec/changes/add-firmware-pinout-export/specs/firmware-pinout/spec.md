# firmware-pinout — Delta Spec

## ADDED Requirements

### Requirement: Sandboxed MCU pinout extraction and drift detection

`extractSchematicPinout`, `runExportFirmware`, and `checkFirmwareDrift` SHALL enforce `resolveInRepo` path sandboxing, extract MCU GPIO/port tokens from multi-function pin names and `PINOUT.md`'s `Name` column, ignore C line and block comments when parsing headers, and report macro mismatches.

#### Scenario: Multi-function pin name resolves to GPIO token

- **WHEN** an MCU pin named `MTCK/GPIO39/CLK_OUT3` is connected to net `JTAG_TCK`
- **THEN** `extractSchematicPinout` emits `{ macro: "PIN_JTAG_TCK", pin: "GPIO39" }`

#### Scenario: Path escaping the repository is rejected

- **WHEN** `runExportFirmware` or `checkFirmwareDrift` is called with `../../outside.h`
- **THEN** it throws an `ExportError` without reading or writing outside the repository

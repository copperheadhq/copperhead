# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `export firmware` and `check --firmware` CLI surface

The CLI SHALL provide `copperhead export firmware [--target c] [--out <path>] [--ref <refdes>]` and `copperhead check --firmware [header] [--ref <refdes>]`, executing `--firmware` as part of `runCheck` and preserving `--json` parity.

#### Scenario: `export firmware` writes header and `check --firmware` verifies it

- **WHEN** `copperhead export firmware` writes `firmware/inc/pinout.h` and `copperhead check --firmware` runs
- **THEN** `check` verifies the header against the schematic and reports `firmware.ok: true`

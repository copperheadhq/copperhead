# add-firmware-pinout-export: Proposal

## Why

When schematic pin assignments change, firmware pin headers easily drift out of sync with the hardware, causing silent bring-up bugs. Engineers need a deterministic, LLM-free command to export MCU pin assignments from the schematic into a C header (`copperhead export firmware`) and a CI-safe check (`copperhead check --firmware`) that verifies the committed firmware header matches the schematic.

## What Changes

- **`copperhead export firmware [--target c] [--out <path>] [--ref <refdes>]`**: deterministically extracts MCU signal pin assignments from the schematic into `firmware/inc/pinout.h` (supplemented by `PINOUT.md`'s `Name` column when symbol pin names are numeric/`~`), filters out power/ground rails via schematic power symbols, `power_in`/`power_out` pin types, and exact rail names, resolves multi-function GPIO pin names (`MTCK/GPIO39/CLK_OUT3` -> `GPIO39`, `PA9/USART1_TX` -> `PA9`), refuses regulator-only boards unless `--ref` is given, enforces `resolveInRepo` path sandboxing (`AC-4.2`), and writes the C header.
- **`copperhead check --firmware [header] [--ref <refdes>]`**: runs inside `runCheck` alongside ERC, DRC, drift, and constraint checks, verifying `firmware/inc/pinout.h` (or `[header]`) against the schematic and exposing `firmware` in `CheckResult`.

## Capabilities

### New Capabilities

- `firmware-pinout`: deterministic MCU pinout extraction, C header rendering/parsing (including `/* ... */` and `//` comment stripping), and schematic-vs-header drift verification.

### Modified Capabilities

- `cli-surface`: adds `copperhead export firmware` and `copperhead check --firmware [header] [--ref <refdes>]` with `runCheck` / `--json` parity.

## Impact

- **Code**: `src/kicad/firmware.ts`, `src/kicad/sexp.ts`, `src/util/errors.ts`, `src/commands/export.ts`, `src/commands/check.ts`, `src/cli.ts`.
- **Docs**: `openspec/specs/SPEC.md`, `README.md`, `docs/src/content/docs/reference/cli.md`.
- **Tests**: `test/firmware.test.ts`.

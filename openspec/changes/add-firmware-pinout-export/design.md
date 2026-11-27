# add-firmware-pinout-export: Design

## Context

MCU pins in KiCad schematics carry net labels (`LED_STATUS`, `UART_TX`, `VBUS_DET`) and multi-function pin names (`PA9/USART1_TX`, `MTCK/GPIO39/CLK_OUT3`). Firmware projects consume these mappings as `#define PIN_<NET> <PIN>` macros.

## Decisions

1. **Clear source-of-truth boundary (`firmware/inc/pinout.h` vs `firmware/src/pins.h`)**: `copperhead export firmware` and `copperhead check --firmware` own `firmware/inc/pinout.h` by default, with the schematic as ground truth (supplemented by `PINOUT.md`'s `Name` column only when a library symbol's pin name is numeric or `~`). `copperhead sync` keeps checking `create` Stage 7's `firmware/src/pins.h` against `PINOUT.md` and does not inspect `firmware/inc/pinout.h`, avoiding conflicting advice. Custom header paths pass `--out <path>` and `check --firmware <path>`.
2. **Repo-sandboxed paths (`AC-4.2`)**: Both `runExportFirmware` and `checkFirmwareDrift` resolve `--out` and `headerPath` via `resolveInRepo`, rejecting any path that escapes the repository root. `ExportError` lives in `src/util/errors.ts` so `src/kicad/firmware.ts` has no circular import with `src/commands/export.ts`.
3. **Unified `runCheck` execution (`AC-2.4`)**: `copperhead check --firmware` delegates through `runCheck(repo, log, opts)` rather than short-circuiting in `src/cli.ts`, preserving full ERC/DRC/drift checks and CLI-to-entry-point JSON parity.
4. **Strict MCU selection and schematic power classification**: `selectMcuRefs` always applies the MCU-hint / GPIO-pin-name filter (even when a board has only one IC) and fails with `no MCU found; pass --ref <refdes>` on regulator-only boards unless `--ref` is explicitly provided. Power supply nets are excluded using KiCad power symbols, `power_in`/`power_out` pin electrical types, and whole-token rail names so GPIO signals like `VBUS_DET`, `VBAT_SENSE`, `VCC_EN`, and `5V_EN` are preserved while `AVCC`, `VIN`, and `3.3V` are excluded.

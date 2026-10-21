# add-firmware-pinout-export: Design

## Context

MCU pins in KiCad schematics carry net labels (`LED_STATUS`, `UART_TX`) and multi-function pin names (`PA9/USART1_TX`, `MTCK/GPIO39/CLK_OUT3`). Firmware projects consume these mappings as `#define PIN_<NET> <PIN>` macros in `firmware/inc/pinout.h` or `firmware/src/pins.h`.

## Decisions

1. **Repo-sandboxed paths (`AC-4.2`)**: Both `runExportFirmware` and `checkFirmwareDrift` resolve `--out` and `headerPath` via `resolveInRepo`, rejecting any path that escapes the repository root.
2. **Unified `runCheck` execution (`AC-2.4`)**: `copperhead check --firmware` delegates through `runCheck(repo, log, opts)` rather than short-circuiting in `src/cli.ts`, preserving full ERC/DRC/drift checks and CLI-to-entry-point JSON parity.
3. **Header path auto-discovery**: When no explicit header path is given to `checkFirmwareDrift`, it checks `firmware/inc/pinout.h` first and falls back to `firmware/src/pins.h` if present.
4. **MCU-aware pin and symbol selection**: `extractSchematicPinout` selects `U*`/`IC*` symbols (preferring MCU symbols and never falling back to passives), extracts the `Name` column from `PINOUT.md` via `parseCanonicalTables`, prefers canonical GPIO/port segments (`GPIO\d+`, `P[A-K]\d+`, `GP\d+`) in slash-separated pin names, and rejects colliding net names that normalize to the same macro.

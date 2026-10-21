# add-bom-symbol-check: Proposal

## Why

Stage 3 (part selection) already has `search_symbols` and `symbol_pins` to check one part at a time, and stage 4 receives the pre-computed `bomSymbolDossier()` pin dossier at entry. Allowing stage 3 to run the same one-shot BOM symbol audit (`check_bom_symbols`) before committing `docs/BOM.md` surfaces missing symbols (`MISS`), unverified short/overflow rows (`INCOMPLETE`), or multi-unit symbols in a single tool call, mirroring `check_footprints`.

## What Changes

- **Add `check_bom_symbols` read-only tool (`src/capabilities/handlers.ts`)**: Runs `bomSymbolDossier` across `docs/BOM.md` against the installed KiCad symbol libraries and prefixes the dossier with `MISS:`, `INCOMPLETE:`, or `OK:` (worded as a candidate check reminding the agent to confirm family hits via `symbol_pins`).
- **Update stage-3 prompt (`src/commands/create.ts`)**: Directs stage 3 to call `check_bom_symbols` alongside `check_footprints` before finishing part selection.

## Impact

- **Code**: `src/capabilities/index.ts`, `src/capabilities/handlers.ts`, `src/commands/create.ts`.
- **Tests**: `test/dossier.test.ts`.

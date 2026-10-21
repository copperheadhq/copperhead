## 1. Implementation

- [x] 1.1 Register `check_bom_symbols` in `src/capabilities/index.ts` and implement its read-only handler in `src/capabilities/handlers.ts` with `MISS`, `INCOMPLETE`, and `OK` headers.
- [x] 1.2 Update stage-3 prompt in `src/commands/create.ts` to invoke `check_bom_symbols` before finishing part selection.
- [x] 1.3 Add unit tests in `test/dossier.test.ts` covering `MISS`, `INCOMPLETE`, `OK`, and early-return paths.

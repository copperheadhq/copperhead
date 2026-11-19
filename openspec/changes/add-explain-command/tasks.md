# Tasks: add-explain-command

## 1. Lookup

- [x] 1.1 Implement `explainQuery` over `listSymbols` / `listNets` / `pinNets` with the D2 resolution order
- [x] 1.2 Attach BOM.md / PINOUT.md rows and doc mentions when those files exist
- [x] 1.3 Format prose and a stable JSON hit (`part` | `net` | `pin`)

## 2. CLI / REPL

- [x] 2.1 Add `copperhead explain <query>` (LLM-free, network-free, no kicad-cli probe)
- [x] 2.2 Add `/explain` to the REPL inspect commands, passing through args
- [x] 2.3 `--json` emits the structured result; unknown queries exit 1 with suggestions

## 3. Tests and docs

- [x] 3.1 Fixture tests: part, net, pin-by-number, pin-by-name, unique pin name, case fold, miss-with-suggestion, no-schematic
- [x] 3.2 CLI contract test for prose and `--json`
- [x] 3.3 SPEC.md, README, CLI reference, verify-and-sync, manual-tests edit sandbox

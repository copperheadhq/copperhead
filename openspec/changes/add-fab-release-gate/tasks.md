# Tasks: add-fab-release-gate

## 1. Gate module

- [x] 1.1 Implement `src/kicad/fab.ts`: routing-completeness check over the normalized DRC report (unconnected items → named nets with locations) — delivered via issue #252
- [ ] 1.2 Implement BOM-readiness check: parse BOM.md rows, flag missing MPN/footprint as failures, `UNVERIFIED` rows as warnings
- [ ] 1.3 Implement schematic-to-PCB match: refdes + footprint join via `list_symbols` and a board-side footprint enumerator added to `src/kicad/sexp.ts` (read-only)
- [ ] 1.4 Implement output-freshness check: read the export hash record from `.copperhead/config.json`, recompute SHA-256 of `.kicad_pcb`, compare; distinct messages for missing outputs, missing record, and stale hash
- [x] 1.5 Implement documentation-presence check (LAYOUT.md `## Draft quality`, DEVPLAN.md for `create` repos)

## 2. Export hash record

- [ ] 2.1 Write the SHA-256 of the source `.kicad_pcb` plus output paths into `.copperhead/config.json` at create stage 6 export time
- [ ] 2.2 Document the record format in the generated `.copperhead/README.md`

## 3. CLI wiring

- [x] 3.1 Add `--fab` and `--strict` flags to `check`/`verify`; run the gate after base checks; aggregate exit code (warnings non-fatal unless `--strict`) — delivered via issue #252 (routing + docs; `bom`/`schPcbMatch`/`outputs` are not reported until 1.2–1.4 land)
- [x] 3.2 Extend `--json` output with the `fab` object — delivered via issue #252 (only `routing` and `docs` are emitted; the remaining keys join once 1.2–1.4 land, so the gate never fakes a pass)
- [x] 3.3 Human-readable output: per-check ✓/⚠/✗ lines with claim/actual/location, matching the drift-report voice — delivered via issue #252

## 4. Fixtures and tests

- [ ] 4.1 Build fixture variants: unrouted net, BOM row without MPN, `UNVERIFIED` row, sch/pcb refdes mismatch, footprint mismatch, stale-hash outputs, missing `## Draft quality`
- [ ] 4.2 Unit tests for each gate check against the fixtures, including `--strict` escalation
- [ ] 4.3 Assert `check --fab` under the network guard: no api.* connections, < 60 s on the fixture
- [ ] 4.4 Assert plain `check` output is byte-identical with and without this change applied

## 5. Docs

- [ ] 5.1 README: fab-gate section under `check` with a sample failure report
- [ ] 5.2 On archive, merge fab-gate criteria into SPEC.md `check` section and AC-2 (via /opsx:archive)

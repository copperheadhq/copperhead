# Tasks: add-fab-release-gate

## 1. Gate module

- [x] 1.1 Implement routing-completeness check over the normalized DRC report
- [x] 1.2 Implement BOM-readiness check with strict export behavior and `UNVERIFIED` inspection severity
- [x] 1.3 Implement refdes, footprint, pad-number, and pad-net parity with fail-closed parsing
- [x] 1.4 Implement output-freshness checks for board hash, Gerber/drill presence, and recorded paths
- [x] 1.5 Implement documentation-presence check (LAYOUT.md `## Draft quality`, DEVPLAN.md for `create` repos)

## 2. Export hash record

- [x] 2.1 Write the SHA-256 of the source `.kicad_pcb` plus output paths into `.copperhead/config.json` at create stage 6 export time
- [x] 2.2 Document the record format in the generated `.copperhead/README.md`

## 3. CLI wiring

- [x] 3.1 Add `--fab` and `--strict` flags to `check`/`verify`; run the gate after base checks; aggregate exit code (warnings non-fatal unless `--strict`)
- [x] 3.2 Extend `--json` output with the `fab` object (`routing`, `bom`, `schPcbMatch`, `outputs`, `docs`, each `{status, violations}`)
- [x] 3.3 Human-readable output: per-check ✓/⚠/✗ lines with claim/actual/location, matching the drift-report voice

## 4. Fixtures and tests

- [ ] 4.1 Build fixture variants: unrouted net, BOM row without MPN, `UNVERIFIED` row, sch/pcb refdes mismatch, footprint mismatch, stale-hash outputs, missing `## Draft quality`
- [ ] 4.2 Unit tests for each gate check against the fixtures, including `--strict` escalation
- [ ] 4.3 Assert `check --fab` under the network guard: no api.* connections, < 60 s on the fixture
- [ ] 4.4 Assert plain `check` output is byte-identical with and without this change applied

## 5. Docs

- [x] 5.1 README: document fabrication inspection, strict export enforcement, and provenance
- [ ] 5.2 On archive, merge fab-gate criteria into SPEC.md `check` section and AC-2 (via /opsx:archive)

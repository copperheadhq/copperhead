# structured-part-selection: Tasks

## 1. Manifest schema and validator (pure, fixture-tested)

- [x] 1.1 `src/kicad/parts/manifest.ts`: `PartsManifest` types, `MANIFEST_VERSION`, `MANIFEST_FILENAME` (`parts.intent.json`), `parseManifest(json)` returning typed entries or shape findings (string fields, unique refdes, grouped refdes such as `C5-C8` refused, version check); verify with `test/parts-manifest.test.ts` covering each shape finding
- [x] 1.2 `src/kicad/parts/passives.ts`: prefix+package → canonical lib_id and stock footprint id table (R, C, L, D, LED, Y, F, FB, SW, TP; 0402/0603/0805/1206, SOD-123, SOT-23 and the common THT sizes); explicit `libId`/`footprint` on an entry wins; verify with a table test that every emitted footprint id resolves against the stock library on this machine
- [x] 1.3 Lift the pin-versus-pad check out of `validateIntent` (`ir.ts`, the #314/#325 block) into `src/kicad/parts/pads.ts` and call it from both validators; verify the existing IR tests still pass unchanged
- [x] 1.4 `src/kicad/parts/validate.ts`: `validatePartsManifest(manifest, { symbols, footprints, subsystemsMd })` producing findings for value-not-description (`looksLikeDescription`), passive expansion, `libId` resolution with nearest ids (reuse `resolveLibrarySymbol` + `searchInstalledSymbols`), footprint resolution with nearest ids (reuse `FootprintResolver`), pads, group coverage both ways against SUBSYSTEMS.md headings, substitution shape and reason, off-board exemptions, MPN presence on non-passives; findings grouped per refdes with a per-call cap and count; verify with fixture-library tests per rule plus an uninstalled-library case classified as the user's stop

## 2. Renderer and readers

- [x] 2.1 `src/kicad/parts/render.ts`: deterministic BOM.md (header line naming the manifest, canonical five columns plus Symbol, `(UNVERIFIED)` suffix, `(off-board)` footprint cell, `## Substitutions` section); verify byte-identical output on repeated render and a round-trip test through `parseBomTable`, `bomFootprintRows` and `checkDrift`
- [x] 2.2 `bomFootprintId` recognises `(off-board)` as no-footprint, and `missingFootprints` callers (pre-schematic stop, populate, `contractGapDetail`) skip off-board rows; verify with a test that an off-board row produces no miss anywhere
- [x] 2.3 `src/memory/drift.ts`: when the manifest exists, add the render-agreement mismatch naming BOM.md and the manifest and the refdes; verify `check` reports a hand-edited Value cell and stays LLM-free (existing AC-2 tests)

## 3. `draft_bom` tool

- [x] 3.1 `src/capabilities/handlers.ts`: `draft_bom` schema (optional `manifest_json`) and handler, `requiresUnlock: true`, mirroring `draft_schematic`: refuse invalid JSON without writing, write the manifest, validate, render on clean, leave BOM.md untouched on findings, mark both files touched; verify with handler tests for clean, findings, invalid JSON
- [x] 3.2 Tool description carries the manifest schema and every rule, so the stage prompt need not; verify the description mentions each field and the off-board and substitution forms

## 4. Stage-3 wiring in `create.ts`

- [x] 4.1 Replace the stage-3 `isComplete` with: manifest present → validator clean and BOM.md equals render; manifest absent → every footprint resolves except an uninstalled library (delete the positional MPN test); verify with tests for clean, model-fixable miss, uninstalled library, off-board row, manifest-less resume
- [x] 4.2 Add a `stageGate` for part-selection calling the same validator so `finish` refuses with the findings; verify with a loop test that finish is refused naming the refdes and nearest ids
- [x] 4.3 `contractGapDetail` for part-selection formats the validator findings (no generic fallthrough when a manifest exists); verify with a unit test
- [x] 4.4 Rewrite the stage-3 prompt per design D10 (task, manifest, `draft_bom`, substitutions, write per subsystem for large boards); remove the per-part `search_symbols`/`symbol_pins` requirement; verify by reading the prompt in the test that pins the stage prompt contract

## 5. Stage-4 and dossier read the manifest

- [x] 5.1 `ir.ts`: when the manifest exists, fill each IR part's `libId`/`value`/`footprint`/`group` from it (IR may omit them), omit off-board refs, refuse an IR ref absent from the manifest or disagreeing with it; keep the BOM.md cross-check for manifest-less repos; verify with IR tests for inherit, disagree, absent, off-board
- [x] 5.2 `dossier.ts`: exact-lib_id path for manifest entries, name-match fallback only without a manifest; verify the dossier lists the recorded symbol's pins and no alternatives line for a manifest entry
- [x] 5.3 Stage-4 prompt: say parts come from the manifest and the IR authors nets and no-connects; verify by prompt-contract test

## 6. Library cache

- [x] 6.1 `src/kicad/cache.ts`: in-process map plus JSON store under `.copperhead/cache/` keyed by library path and mtime, loaded lazily and flushed at process exit; `resolveLibrarySymbol` and `FootprintResolver.resolve` consult it; verify hit on unchanged file, miss on mtime change, ignore on corrupt store
- [x] 6.2 Make `.copperhead/cache/` ignore itself (a `.gitignore` of `*` inside it, as the response cache does) so the user's .gitignore is never touched, and add it to this repo's .gitignore; verify a create-stage rollback (`restore()`) leaves the store in place and git status stays clean

## 7. Specs and docs

- [x] 7.1 SPEC.md §2.5 pipeline diagram: stage 3 line becomes `part selection (parts.intent.json → draft_bom → BOM.md) [gate: validator clean]`; add AC-19 block mirroring the delta scenarios (AC-18 is taken by harden-stage-recovery); verify `openspec validate structured-part-selection` passes
- [x] 7.2 `.copperhead/README.md` and `docs/` user docs mention the manifest, the Symbol column, off-board rows and the cache dir; verify the docs build

## 8. Verification

- [x] 8.1 Typecheck, full vitest suite, build green
- [x] 8.2 Fixture end-to-end: run stage 3 through the pipeline with a scripted provider that writes a manifest with one bad footprint, one off-board row and one substitution; verify finish is refused once with the footprint, completes after the fix, BOM.md matches the render, and stage 4's dossier uses the recorded lib_ids

## 9. Review and live-run follow-ups

- [x] 9.1 `noPart` entries (design D11): manifest field and shape check, MPN rule waived, `noPart` with `mpn` or `offBoard` refused, `(no part)` rendered and read back as `NO_PART`; the `draft_bom` description and the stage-3 prompt name the flag; verify with validator and render tests.
- [x] 9.2 Supplier export reads the render (design D12): only Refdes-headed tables are parts, the `(UNVERIFIED)` annotation is stripped from the orderable MPN, no-part rows are on no order, off-board rows are on distributor carts and off the JLCPCB assembly BOM; verify by exporting a render that has a substitution, an unverified MPN, an off-board part and a board feature.
- [x] 9.3 Invalid manifest is reported (design D13): `loadManifest` tells absent, invalid and ok apart; drift and the IR validator report an invalid file; verify with a truncated manifest and a wrong field type.
- [x] 9.4 Stage-3 prompt points passives at `package`; SPEC.md AC-19.9 to AC-19.11 and the delta specs updated; `openspec validate` passes.

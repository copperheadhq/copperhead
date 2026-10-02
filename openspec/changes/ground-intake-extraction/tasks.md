## 1. Vendor the knowledge core (design D1)

- [x] 1.1 Copy cortex `origin/main` b4a45e8 `packages/{core-types,decimal,parsers,validators,ladder,verdict-engine,conformance-kit,eval-harness}/src` and `packages/ingestion/src/segmenter.ts` into `intake/core/knowledge/{types,decimal,parsers,validators,ladder,verdict,conformance,eval,segment}/`; rewrite `@copperhead/*` imports as relative imports; write the ladder's NUL key separator as `\u0000`
- [x] 1.2 Move the packages' tests to `intake/test/knowledge/` and add `fast-check` as a dev dependency; the copied suites pass unchanged apart from imports (verdict engine and validators: 27 tests)
- [x] 1.3 `intake/core/knowledge/PROVENANCE.md`: source commit, each copied path with its line count, and a running list of every change made in the copy; the cortex attribution added to the repository NOTICE
- [x] 1.4 Boundary test: nothing under `intake/core/` imports a vendor SDK, `node:fs` or Next.js; `core/knowledge/verdict/` imports only `types` and `decimal`

## 2. Close the engine's gaps and extend it (design D7)

- [x] 2.1 `evaluate` catches unit errors and holds with `DIMENSION_MISMATCH`; honours `policy.missingCondition`; holds with `UNSUPPORTED_OPERATOR` on an unknown kind
- [x] 2.2 Applied terms `{label, value}` in `CheckRequest`, summed exactly in `budget_sum` and compared in stress checks
- [x] 2.3 `stressFrom` on `max` constraints: the applied value against the ABS_MAX reading and the rule's limit, citing the lower one exceeded; ABS_MAX used nowhere else
- [x] 2.4 Tests: each closed gap, applied terms in a budget, a stress refusal on the absolute maximum and on the rule, ABS_MAX never used as a guarantee qualifier, the 100-run determinism test still passing; PROVENANCE updated

## 3. Source text (design D2; source-text)

- [x] 3.1 `core/text/` page reader: pdf.js legacy build on the server, `getTextContent` per selected page, items to lines by baseline, ` | ` at cell gaps, line boxes normalised to 0..1
- [x] 3.2 Usable-layer test (at least 200 characters, under 2 percent replacement, private-use or control characters) and the OCR fallback through the existing Sarvam provider, with HTML tables converted to pipe rows and region boxes kept
- [x] 3.3 Page marking (`pdf-text` or `ocr`) with reader versions; the `forceOcr` option
- [x] 3.4 Segmenter extended to mint a unit for every line, with header and footnote context, ids `ev-<sha8>-p<page>-l<line>`, section, page and box
- [x] 3.5 Tests: the four demo PDFs read from their text layers, rows and columns of an electrical characteristics table, a synthesised image-only PDF sent to OCR, a garbled text layer sent to OCR, deterministic ids across two reads, footnote attachment, `forceOcr` marking

## 4. Extraction contract (design D3)

- [x] 4.1 Prompt and output schema in `adapters/extractor-common.ts`: units listed with ids; per field the evidence id, value and unit as printed, qualifier, raw conditions, footnote flag and confidence; no snippet or coordinates; the template hash computed from its text
- [x] 4.2 Both extractors (API and Claude Code) on the new schema, with defensive re-validation of their output and their model id reported in the ingest result
- [x] 4.3 The vendored `ExtractionProvider` takes a list of units; the intake's extractors implement it
- [x] 4.4 Tests: schema rejection of extra fields, an unknown evidence id, a refusal, both extractors from fixtures

## 5. Validation (design D4; extraction-validation)

- [x] 5.1 Pipeline running the vendored validators plus qualifier column, unit present, number words and worded bounds, and footnote hold, in the order of the spec, with outcomes ADMITTED, REVIEW_REQUIRED or REJECTED and reason codes
- [x] 5.2 Parsers extended with number words zero to twenty and worded bounds; containment accepting a word form; bound direction checked against the citation's wording
- [x] 5.3 Confidence below 0.75 routes an admitted extraction to review and is used nowhere else
- [x] 5.4 `AdmittedReading` type requiring an evidence unit with text and box
- [x] 5.5 Tests: each validator's pass and failure, a typical value reported as maximum, an invented unit, "nine" grounding 9, "within" refusing a minimum, low confidence routed to review, high confidence not overriding a rejection, range invariants and duplicates

## 6. Readings, registry and cache (design D5, D6, D9)

- [x] 6.1 `core/model.ts` on the vendored types: parameters, readings, parts, documents; `core/fields.ts` as field requests with parameter specs; `supply_voltage_range_V` split into `supply_voltage_V` MIN and MAX; `core/units.ts` removed for the vendored units
- [x] 6.2 Registry `data/registry.json`: parts with their documents and parameters, constraints with decimal limits, policies and `stressFrom`; strict validation failing closed; atomic writes; new seed
- [x] 6.3 Corrections appended as human readings; the ladder computing canonical values and statuses; extracted readings kept
- [x] 6.4 Cache keys with full key material per stage; entries served only on an exact match; `refresh: true` removed; explicit re-extraction recording a new pass and the readings that differ
- [x] 6.5 Tests: no reading crosses parts, a correction verifying a value, a model change missing the cache, a page change missing the cache, an explicit re-extraction keeping the old pass, a malformed registry failing closed

## 7. Verdicts and manifest (design D7, D8)

- [x] 7.1 `core/engine.ts` replaced by the vendored engine; `ChangeDescriptor` mapped to `CheckRequest` with parameter and applied terms; `proposeFix` moved beside it; snapshots built from the evaluated part only
- [x] 7.2 `/api/evaluate` without the cross-part merge; `/api/ingest` returning readings, outcomes, page text sources and the models that ran; `/api/registry` corrections as human readings
- [x] 7.3 Manifest with document sha256, page text sources, models as run, prompt hash, validator versions, fact versions, reason codes, rule version and decision run id; `reproduces()` on canonical JSON
- [x] 7.4 Tests: the engine scenarios of the spec through the API layer, manifest reproduction with keys reordered

## 8. UI (design D10)

- [x] 8.1 Fact table showing per parameter its readings, qualifiers, values, conditions, statuses, reason codes, text sources and verified marks; review and rejected styling
- [x] 8.2 Click-to-source from the evidence unit's box; text matching removed from `components/PdfViewer.tsx`
- [x] 8.3 Correction form appending a human reading with the person's name
- [ ] 8.4 Browser check of the three demo parts: click-to-source, a review item, a correction, a refusal with both citations visible

## 9. Fixtures and golden tests (design D11)

- [x] 9.1 Extract the four demo datasheets once, live, with the Claude Code extractor; commit the outputs under full keys; delete the old snippet-based entries
- [x] 9.2 GT-1 to GT-5 rewritten to the new shapes with unchanged outcomes; GT-6 replaying its Sarvam output under `forceOcr` with unchanged outcomes
- [x] 9.3 `scripts/demo-acceptance.mjs` reading the new response fields, its three flows and outcomes unchanged; run it twice from cold
- [x] 9.4 `scripts/generate-fixtures.ts` on the new model and keys

## 10. Evaluation (design D12; extraction-evaluation)

- [x] 10.1 The vendored harness reading PDFs through `core/text/`; its corpus format, scoring, gates, audit and baseline kept; per-validator rejection and review counts added to the report
- [x] 10.2 `npm run eval -- --corpus <dir> [--live]`, offline by default, documents without a cached extraction reported as not evaluated
- [x] 10.3 First corpus: the datasheets of ICs on the BoardRepo boards (`eval/corpus-boardrepo`, 21 documents, 8 vendors), labelled by Claude from the datasheet text; run it and record the result in the change, stating that it measures and does not certify
- [x] 10.4 The conformance kit's fixtures, including prompt injection and forged evidence, run against the Claude Code extractor (passed; the API extractor needs an ANTHROPIC_API_KEY this machine does not have)

## 11. cortex freeze (design D14)

- [ ] 11.1 With the owner's agreement, add the frozen notice to cortex's README (frozen 2026-10-02, superseded by the intake for extraction, packages vendored at b4a45e8)

## 12. Verification

- [x] 12.1 `npm run typecheck` in `intake/` (clean)
- [x] 12.2 `npm test` in `intake/`, stating the test count and which tests needed a live provider (197 tests in 21 files; none needs a live provider: the live extraction ran once into the cache, and the tests read the cache)
- [x] 12.3 `npm run build` in `intake/`
- [x] 12.4 `openspec validate ground-intake-extraction --strict`
- [ ] 12.5 Note in `add-layout-guidance-intake` that it rebases onto this change (design D13)

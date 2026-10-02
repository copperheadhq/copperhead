# Design: ground-intake-extraction

## Context

`add-datasheet-intake` built the intake as a demo-scoped surface:

- Sarvam digitises up to two pages.
- An LLM extractor returns fields with free-text snippets and a self-reported confidence.
- A pipeline trusts a field when its snippet occurs in Sarvam's text and its confidence is at least 0.75.
- A pure verdict engine answers APPROVE, REFUSE or HOLD for a structured change.

Its invariants are sound: a held fact never decides, the engine is pure, a trusted fact without provenance cannot be constructed, and fixtures replay with no network. Its model of a fact is too thin to keep them on real datasheets, and its checks verify the model against another model's output.

copperhead-cortex was built as the parts-knowledge plane: ingestion, validation, a git world graph, a query API and a verdict engine, behind provider interfaces for cloud services. Two things decided its future:

- No product code calls it.
- It never parsed a PDF: its segmenter reads pipe-separated text, and its cloud extractor receives unit text.

The decision of 2026-10-02 freezes it and makes the intake the one extraction path. Its pure packages are the most rigorous code either codebase has:

- The verdict engine and validators pass 27 of 27 tests.
- The engine tests include 100-run byte-identical output.
- A dependency rule keeps the engine importing only types and decimals.

Facts this design relies on, checked on the code:

- The intake already depends on `pdfjs-dist` 6.1.200, but only the browser viewer loads it, and it never reads text content.
- All four demo PDFs (LM555, SN74LS00, ESP32-WROOM-32 and the onsemi 2N3055) have full text layers. The 2N3055 has about 36,800 characters over five pages. GT-6 has treated it as scanned only because everything goes through OCR.
- Sarvam's page text renders tables as HTML, so today's cached snippets are `<td>` fragments.
- The extraction cache key is `sha256(pdf)` plus a hash of the field specs. It does not include the model, the prompt template, the pages or the Sarvam options. Live mode passes `refresh: true`, which re-runs extraction on every ingest.
- The manifest's `digitiseModel` is a constant and its `extractorModel` comes from the environment, not from the ingest that ran.
- The registry is one part's facts keyed by parameter name. `/api/evaluate` merges registry facts over posted facts, and the registry copy wins.
- cortex's engine compares a part's guaranteed values with a board rule. It never uses absolute-maximum ratings. The intake's GT-2 compares a voltage a change applies with the part's absolute maximum. The two engines answer different questions, so the port extends cortex's engine rather than swapping it in unchanged.
- cortex's verdict engine has three gaps:
  - a unit dimension mismatch between a fact and a limit throws instead of holding
  - `policy.missingCondition` is never read
  - `UNSUPPORTED_OPERATOR` is never emitted
- cortex's parsers do not read number words ("nine") or worded bounds ("at least", "up to"), and its containment validator is a plain substring test of the value against the unit text.
- `packages/ladder/src/ladder.ts:81` in cortex contains a literal NUL byte inside a template literal.

## Goals / Non-Goals

**Goals:**

- Every admitted reading rests on text the core read from the document itself, or on OCR marked as such. The model points at that text; it never supplies it.
- A value keeps its qualifier, conditions, footnotes and exact decimal value from extraction to verdict.
- Facts never cross parts or documents.
- A cached extraction replays only for the exact inputs that produced it, and every manifest names what actually ran.
- Extraction accuracy is measurable offline against labelled datasheets, with gates that say whether it is good enough to run without review.
- The existing invariants hold: a pure fail-closed engine, no held value deciding anything, provenance enforced by types, and zero network in fixtures mode.

**Non-Goals:**

- The world graph, query service, HTTP API, MCP server, cloud providers, Postgres index or tenancy from cortex.
- Corroboration across many users' documents. The ladder runs over the documents one registry holds.
- Finding the relevant pages automatically. The person still names them.
- Layout guidance. `add-layout-guidance-intake` rebases onto this change and reuses its units and validators.
- Building the full labelled corpus. The harness and the first small corpus are in scope; the 20 to 50 datasheet, five-vendor, dual-labelled corpus is data work.

## Decisions

### D1: Vendor cortex's pure packages as source, owned by the intake

The packages are copied from cortex `origin/main` at b4a45e8 into `intake/core/knowledge/`, one folder per package:

- `types` (model and reason codes)
- `decimal`
- `parsers`
- `validators`
- `ladder`
- `verdict`
- `segment` (the segmenter only)
- `conformance`
- `eval`

`@copperhead/*` imports become relative imports, and the packages' tests move to `intake/test/knowledge/`. `intake/core/knowledge/PROVENANCE.md` records the source commit, each copied path and its line count, and every change made in the copy. The repository NOTICE gains the cortex attribution; both projects are Apache-2.0. The NUL key separator in the ladder is written as `\u0000`. After the copy the intake owns the code; nothing is synchronised back.

The dependency rule cortex enforced with dependency-cruiser becomes a test in the intake: `verdict` imports only `types` and `decimal`, and nothing under `core/` imports an SDK, `node:fs` or Next.js.

- *Alternative: depend on the cortex packages.* Rejected: the repository is frozen and in another organisation, and the intake is a self-contained workspace by design (`add-datasheet-intake` D1).
- *Alternative: rewrite the rigor in the intake's style.* Rejected: the cortex packages already handle exact decimals, condition coverage and qualifier policy, and are tested; rewriting them would recreate their bugs before their fixes.
- *Not copied:* cortex's ingestion pipeline (filesystem checkpoints and the world graph), world graph, query service, index store, API, CLI, KiCad resolver and providers. The evaluation harness's import of `@copperhead/ingestion`, which pulls in the world graph, is replaced by the segmenter and the intake's text reader.

### D2: Read the text layer first; OCR only where there is none

`core/text/` reads each selected page with pdf.js on the server (the legacy build, no worker) and builds lines:

- Text items are grouped by baseline, within half the median font height.
- Each line is ordered by x.
- Items are joined with a space, or with ` | ` where the horizontal gap exceeds a cell gap of 1.5 median character widths. A table row therefore arrives in the segmenter's pipe-row form, and its cells keep their column positions (D5).
- Each line's bounding box is the union of its items, normalised to 0..1 of the page, the coordinate space Sarvam's boxes and the viewer already use.

A page's text layer is usable when it has at least 200 characters, and fewer than 2% of them are the replacement character, private-use or control characters. A page that fails the test goes to Sarvam. Its HTML tables are converted to pipe rows, and each row takes the box of the Sarvam region that holds it. Every page records `textSource: "pdf-text" | "ocr"` and the reader's version: the pdf.js version plus the row builder's version.

A `forceOcr` option sends every selected page to OCR. GT-6 uses it to replay its cached Sarvam output for the 2N3055, and a diagnostic use compares the two texts. The usable-layer test is checked against a synthesised image-only PDF, so the fallback is tested without a Sarvam call.

- *Alternative: keep OCR for everything and also compare it with the text layer.* Rejected as the default: it doubles cost and rate-limit exposure, and where the text layer exists it is the document's own text. It remains available as the diagnostic.
- *Alternative: a PDF table-extraction library.* Rejected for now: a new dependency for what a baseline grouping of pdf.js items does. The row builder is versioned, so a better one replaces it with a key change (D9).

### D3: Evidence units are minted by the core, and the model only points at them

The segmenter mints an evidence unit for every line, not only for table rows as in cortex:

- the id `ev-<sha8>-p<page>-l<line>`
- the line's text
- its context: the table header row and any footnote it references, by reference
- section, page and bounding box

The extraction prompt lists the units of the selected pages with their ids. The extractor returns, per field, cortex's `RawExtraction`: the field, `evidenceId`, the value and unit as printed, the qualifier, raw conditions, a footnote flag and a confidence. Snippet text and coordinates are not in the output schema.

A citation is therefore an id the core minted. Its text is what the core read, and its box is where the core read it. The loose snippet match (whitespace squashed, lower-cased, substring) is deleted. Both extractors (the API extractor and the Claude Code extractor) implement the new schema, and both re-validate it defensively.

The harness calls an extractor once per evidence unit, and the intake calls it once per document, so the vendored `ExtractionProvider` takes a list of units (D12).

- *Alternative: keep snippets and tighten matching.* Rejected: any snippet scheme lets the model write the quote, and matching it against text is exactly the step that let OCR errors through.

### D4: Validation outcomes replace trusted and held

Every extraction runs cortex's validators: lineage, numeric, unit system, qualifier, conditions, citation containment, revision authority, range invariants and duplicate reconciliation. The intake adds four:

- **Qualifier column.** When the unit's context has a header naming MIN, TYP, MAX, NOM or an absolute maximum, the value's cell index must be the column of the qualifier the extraction claims. Otherwise the extraction is REJECTED with `QUALIFIER_COLUMN_MISMATCH`. This catches a typical value reported as a maximum.
- **Unit present.** The unit as printed must occur in the unit's text or its header context. Otherwise the extraction is REJECTED with `UNIT_NOT_CONTAINED`.
- **Number words and worded bounds.** The parsers read zero to twenty as words, and read worded bounds:
  - "at least", "minimum" and "no less than" bound from below
  - "at most", "maximum", "up to", "within", "less than" and "no more than" bound from above

  Containment accepts a numeral whose word form is in the text, and a bound must match its wording. Values are mostly numerals in tables, but layout guidance and prose limits need this.

- **Footnote hold.** A value flagged as qualified by a footnote is REVIEW_REQUIRED unless the footnote's text is carried as a condition note.

Outcomes:

- ADMITTED readings may decide verdicts.
- REVIEW_REQUIRED readings are held for a person, with their reason codes.
- REJECTED extractions are kept in the record with their reasons and never become readings.

Confidence only routes: an ADMITTED extraction whose confidence is below 0.75 is moved to REVIEW_REQUIRED, and confidence never admits anything. That keeps the intake's threshold as a filter on the model's self-report (RFC 17 §6.5).

The type `AdmittedReading` requires an evidence unit with text and a bounding box, so the old guarantee (no trusted fact without provenance) carries over.

### D5: Readings, parameters and parts replace facts

The fact model becomes cortex's:

- A `Parameter` has a key, a dimension and its readings.
- Each `Reading` has an exact `Decimal` measurement (value, unit and SI value as decimal strings), a qualifier, a `ConditionSet`, its evidence unit, its contributor and method, the validators it passed, and when it was added.
- A part's identity is `manufacturer:mpn`.
- A document is a `DocumentRef` with its sha256, revision and authority.

`FieldSpec` becomes cortex's `FieldRequest` with a `ParameterSpec`: the expected dimension and required conditions. Parameter keys keep their current names so cited keys in verdicts stay stable, with one exception: `supply_voltage_range_V` becomes `supply_voltage_V` with separate MIN and MAX readings.

The extractor reports a range printed in one cell ("4.5 to 16 V") as two extractions, MIN and MAX, citing the same unit, and each passes containment on its own value. An extraction that still carries a range, an inequality or a tolerance as its value goes to review through cortex's numeric validator, so a range is never stored as one value. The vendored decimal units replace `core/units.ts`; they add W, F, H, s, Ah, °C and %.

### D6: The registry is per part and per document

`data/registry.json` replaces `data/constraints.json`:

- `parts` maps each part id to its documents and parameters.
- `constraints` holds the board rules.
- A reading belongs to exactly one part and one document.

`/api/evaluate` builds the snapshot only from the evaluated part's parameters. The merge that let a stored fact from one part decide a verdict about another is removed.

A correction appends a reading with `method.kind: "human"` and the person's name as contributor. The ladder computes the canonical value per qualifier and condition group, and a human reading makes it `verified`. Nothing is overwritten, and the extracted reading stays beside the correction. Registry writes stay atomic (temp file, then rename), and a malformed registry still fails closed with a typed error. The seed is rewritten. The demo registry is gitignored state, so there is no data to migrate.

### D7: cortex's verdict engine, with its gaps closed and two extensions

The vendored engine replaces `core/engine.ts`. It keeps:

- exact sums in the limit's unit
- guarantee qualifiers: under WORST_CASE, `max` and `budget_sum` need MAX readings, `min` needs MIN and `equality` needs NOM; TYPICAL_OK accepts TYP
- condition coverage by interval containment
- revision-conflict and disputed-fact holds
- the strict-status policy
- reason codes on every verdict
- the injected clock and run id

Closed in the copy:

- **Unit mismatch.** `evaluate` catches the unit error and holds with `DIMENSION_MISMATCH`; it no longer throws.
- **Missing conditions.** `policy.missingCondition` is honoured.
- **Unknown kinds.** An unknown constraint kind holds with `UNSUPPORTED_OPERATOR`.

Extended:

- **Applied values.** A change's contribution with an explicit value becomes an applied term, `{label, value: Decimal}`. It counts in a `budget_sum` beside fact terms, and it is the compared value in a stress check. A contribution without a value names a parameter of the evaluated part, as before.
- **Absolute-maximum stress checks.** A `max` constraint MAY name `stressFrom: {key}`. The check then compares the applied value with the part's ABS_MAX reading for that key, as well as with the rule's own limit, and refuses when either is exceeded, citing whichever was. This is the only use of an absolute-maximum reading. It never becomes a design target or a guarantee qualifier, consistent with RFC 4 §5.2. When both limits are exceeded, the check cites the lower one, as the intake's engine does today with its effective ceiling. GT-2 is this check, and its outcome is unchanged:
  - Its seed sets the rail rule to 5 V.
  - 5 V applied against a 3.6 V absolute maximum refuses, computed as 5 V against 3.6 V, citing the absolute-maximum reading and `rail_voltage_max`.
  - The demo seed's 3.3 V rule makes the demo acceptance flow refuse on the rule's own limit.

`ChangeDescriptor` maps to the engine's `CheckRequest`: the part, the change, the requirement conditions, and terms that are either parameter keys or applied values. `proposeFix` stays deterministic and moves beside the engine.

- *Alternative: keep the intake's engine and add decimals and qualifiers to it.* Rejected: cortex's engine already has condition coverage, guarantee policy and the determinism suite, and two engines are what this change removes.

### D8: The manifest names what ran and reproduces canonically

The manifest records:

- the document's sha256 and revision
- each page's text source and reader version
- the extractor model as reported by the ingest that ran
- the prompt template hash
- the validator versions
- the fact versions used (`{key, qualifier, sha256, status}`)
- the verdict's reason codes and rule version
- a decision run id

`digitiseModel` is set only when a page used OCR. `reproduces()` compares canonical JSON (keys sorted), so key order no longer decides reproducibility.

### D9: Cache keys hold every input, and re-extraction is a new pass

Each cache key, and each cache entry, holds every input that produced it:

- **Text:** the document sha256, the sorted page list, and the reader version.
- **OCR:** the document sha256, the page list, the provider id, the language and the output format.
- **Extraction:** a digest of the evidence units given (ids and text), a digest of the field requests, the extractor's model id, the prompt template hash and the output schema version.

An entry is served only when every part of its key matches. The `refresh: true` path is removed. Extracting again for the same inputs is an explicit action that writes a new pass beside the old one and reports the readings that differ; it never silently replaces the old pass (RFC 17 §4.4).

The committed fixtures are regenerated (D11). A re-keying script refuses to re-key an entry whose prompt hash it cannot establish.

### D10: The UI shows readings, statuses and reasons

The fact table lists, per parameter:

- each reading's qualifier, value and unit, conditions and text source
- its status: ADMITTED, REVIEW_REQUIRED with reason codes, or REJECTED with reason codes
- whether a person verified it

REVIEW_REQUIRED and REJECTED keep the amber "review" styling. Clicking a reading scrolls to its page and highlights its evidence unit's bounding box. The viewer no longer matches snippet text against regions. The correction form appends a human reading.

### D11: Fixtures are regenerated once, live

The cached extractions cite snippets, so they cannot be re-keyed into evidence-unit citations. The four demo datasheets are extracted once, live, with the Claude Code extractor on a saved login, and the output is committed with its full key. GT-6 keeps its committed Sarvam output and runs with `forceOcr`; its expectation (the absolute-maximum reading held for low confidence, the change held) is unchanged.

GT-1 to GT-5 run on the synthetic DEMO-IO-EXPANDER, whose cache entries are written by the test, so they are rewritten to the new shapes with the same outcomes. `scripts/demo-acceptance.mjs` keeps its three flows and outcomes and reads the new response fields.

### D12: Evaluation runs the intake's extractor through cortex's harness

`core/knowledge/eval` is the vendored harness:

- the corpus format (documents, labelled fields and adjudicated labels, decision fixtures and release sets)
- scoring and the gates: field precision ≥ 0.98, condition F1 ≥ 0.95, citation accuracy 1.0, no wrong-while-confident readings, decision accuracy 1.0, zero false APPROVE, insufficient-evidence fixtures holding, and cost to verify under ten minutes
- the corpus audit
- the baseline comparison against a raw model

Two changes in the copy:

- `ExtractionProvider.extract` takes a list of units.
- A document is read through the intake's text reader from its PDF rather than from inline text.

`npm run eval -- --corpus <dir>` runs offline from cached extractions. With `--live` it runs the extractor, and its output joins the cache under D9's keys.

Citation accuracy is scored on the evidence unit's page and text. The report adds, per validator, how often it rejected or sent an extraction to review, which is the model-error measure of RFC 17 §13.3.

The first corpus is cortex's `corpus-demo` plus the four demo datasheets, labelled by hand. A calibration record is minted only when the corpus audit passes, which this first corpus will not. Its run measures; it does not certify.

### D13: Sequencing with the other intake changes

This change stacks on `add-datasheet-intake` (PR #92) and is archived after it. It modifies five of that change's capabilities by name.

`add-layout-guidance-intake` (designed, not implemented) rebases onto this change:

- Its guidance items cite evidence units.
- Its guardrails become validators here (number words, worded bounds, unit containment, footnotes).
- Its export carries the document sha256 and text source that this change provides.

Its migration note, "facts flow, registry format and verdict engine are unchanged", no longer holds and is updated when it rebases.

### D14: cortex is frozen, not deleted

cortex's README gains a notice: frozen on 2026-10-02, superseded by the intake for extraction, packages vendored at b4a45e8. No other change is made there, and the notice is committed only with the owner's agreement. RFC 4 remains the standard the intake implements for the parts it ingests.

## Risks / Trade-offs

- **[Text-layer rows on real datasheets]** Multi-line cells, rotated headers, superscripts ("VDD^1+0.3") and two-column layouts break baseline grouping.
  → Units are lines first, and rows only where cells align. A value that does not sit in its unit fails containment and is held, never admitted. The row builder is versioned and fixture-tested on the demo datasheets, and a page can be forced to OCR.
- **[Blast radius]** The model, pipeline, engine, registry, routes, UI and most of the 75 tests change together.
  → The tasks are ordered so the vendored core and its tests land first, unchanged except for imports. The engine extensions land with their own tests before the intake switches to them.
- **[Prompt size]** Listing every unit of a 40-page datasheet would be large.
  → Pages stay selected by the person, a few at a time, as today.
- **[pdf.js on the server]** The legacy build must run in the Next.js server runtime without a worker.
  → It is loaded only in API routes and scripts, and is pinned to the locked version, which is part of the text cache key.
- **[Model-reported confidence]** It stays in the record and still routes items to review.
  → It never admits a reading, raises a status, or appears as a confidence in a verdict.
- **[An evaluation corpus too small to certify]**
  → The harness refuses to mint a calibration record until the corpus audit passes, so a small run cannot be presented as certification.

## Migration Plan

- Demo state (`data/`) is reset to the new seed. Exported manifests from earlier versions remain readable as JSON, but `reproduces()` applies only to the new format.
- Fixture cache files are regenerated (D11). Old entries are deleted in the same commit.
- Rollback is reverting the change. Nothing outside `intake/`, `openspec/` and the NOTICE is touched.

## Open Questions

- Whether a guidance-heavy page (layout guidance) needs paragraph-level units in addition to lines. To be settled when `add-layout-guidance-intake` rebases.
- Whether to keep cortex's corroboration ladder status names (`extracted`, `corroborated`, `verified`, `disputed`) in the UI, or show only verified and not-yet-verified.
- Who labels the first corpus, and whether the second labeller required by the corpus audit is available.

## Implementation Notes

Where the implementation departs from the decisions above, and why:

- **Harness location (D1, D12).** The evaluation harness lives in `intake/eval/`, not `intake/core/knowledge/eval/`, because it reads its corpus from disk and `intake/core/` holds no I/O. The boundary test enforces that.
- **pdf.js placement (D2).** The pdf.js reader is an adapter (`adapters/pdf-text.ts`). The line builder, the usable-layer test, the OCR row conversion and unit minting are pure modules in `core/text/`. The cell gap is 0.8 em, measured on the demo datasheets: ESP32's narrowest column gap is 1.1 em, and justified prose reaches about 0.6 em.
- **Unit minting (D3).** Units are minted by `core/text/units.ts` rather than by extending cortex's segmenter, which stays as copied for the harness's text corpora.
  - A table row's context holds its header and its own table's footnotes. Footnote numbering restarts per table, so a reference resolves to the next definition after it.
  - The rows around it are kept apart as `neighbors`. Only the unit-present check reads them, never containment.
- **Number words (D4).** Cortex's containment check reads the unit text with number words as numerals; the intake's own value-in-unit check reads the printed text.
- **GT-6 (D11).** GT-6's July capture is a labelled test fixture (`fixtures/gt6/`), translated from snippet to pointer, and not a cache entry, because the current prompt did not produce it.
- **Corrections (D6).** A correction of a value held for review becomes a human reading citing the reviewed line (`confirmReading`). A correction that names a line corrects that line's reading, never another reading with the same qualifier.
- **Symbolic conditions.** Conditions such as TI's "VCC = MAX" do not parse as values, so those readings go to review (`CONDITION_MISMATCH`), as cortex's conditions validator requires. All of SN74LS00's demo readings are held for this reason.
- **Values printed fused with their unit.** Microchip and others print "7.0V". The first evaluation showed the extractor reporting such a value exactly as printed, which then failed numeric parsing. Validation now reads a fused value as its number and unit, deterministically, before any check. The value-in-line check still finds "7.0" inside "7.0V", and a unit the extractor named differently leaves the value as printed.
- **Evaluation through the intake (D12).** `eval/intake.ts` ingests each corpus PDF through the production ingest, using the text layer, evidence units, the extractor or its cache, and validation, and scores only admitted readings with cortex's harness. The runner is `scripts/eval.ts` (`npm run eval`). `scripts/eval-details.ts` writes every extraction with its outcome and label match. `scripts/fetch-corpus.ts` fetches the corpus's PDFs by URL and sha256.
- **The first corpus (D12).** The first corpus is `eval/corpus-boardrepo`: datasheets of ICs that BoardRepo boards' KiCad symbols link to. It was labelled by Claude from the datasheet text alone, never from extractor output, and has one labeller only, so the corpus audit fails and the run measures rather than certifies. The demo corpus and the four demo datasheets were not used: the BoardRepo corpus replaced them as the first evaluation.

## First Evaluation (task 10.3)

**Setup:**
- Corpus `eval/corpus-boardrepo`: 21 datasheets of ICs on 18 BoardRepo boards, 8 vendors.
- 213 labelled readings over each document's absolute-maximum, operating-condition and electrical-characteristics pages.
- Five decision fixtures whose expected verdicts come from the labels.
- Extractor: Claude through the Claude Code saved login.
- Every page was read from the PDF's text layer; none needed OCR.
- Results are in `intake/eval/results/`.

| Measure | Result |
|---|---|
| Extractions proposed | 216: 105 admitted (103 after merging duplicates), 59 held for review, 52 rejected |
| Field precision | 0.981 (101 of 103) |
| Field recall | 0.418 |
| Wrong while confident | 0 |
| False APPROVE | 0 |
| Insufficient-evidence fixtures | all HOLD |
| Citation accuracy | 0.871 |
| Condition F1 | 0.490 |
| Decision accuracy | 0.8 |
| Conformance suite (Claude Code extractor) | passed, including prompt injection and forged evidence |

**The two wrong admitted readings are definitional, not misreads:**
- AP3211's feedback bias current, read as input leakage. The labels exclude analog bias currents.
- APX811's electrical-characteristics V<sub>CC</sub> range of 1.0 V. The labels take the 1.1 V of Recommended Operating Conditions.

**Citation accuracy:** all 13 mismatches cite a different line that prints the same value. The labels cite one table per value, so this measure undercounts.

**Condition F1** is low because the labels take only row-level conditions, while the extractor also reports table-wide defaults, or omits conditions.

**Decision fixtures:** the one failure is MCP2515, which holds (`CONDITION_NOT_COVERED`) because its admitted operating current carries no conditions. That is conservative, not a false APPROVE.

**Checks added because of this evaluation.** Three general fixes were made after the first pass, each with unit tests:
- A value printed fused with its unit ("7.0V") is read as its number and its unit.
- `range-position`: a value at the lower end of a range printed in one cell ("-0.3 to 6.5") is a minimum, never a maximum or an absolute maximum.
- Dot leaders ("VCC......6.5V") are not read as decimal points or as range separators.

`scripts/ablate.ts` measures their effect exactly. It re-validates the same cached extractions with the validators of commit 9cfa724, from before this evaluation, and then adds the fixes one at a time.

| Validators | Admitted | Correct | Wrong | Precision | Recall |
|---|---|---|---|---|---|
| None: every extraction that parses | 187 | 152 | 35 | 0.813 | 0.601 |
| As before this evaluation (9cfa724) | 98 | 95 | 3 | 0.969 | 0.390 |
| + fused value and unit | 100 | 96 | 4 | 0.960 | 0.394 |
| + dot leaders | 100 | 97 | 3 | 0.970 | 0.399 |
| + range position (final) | 103 | 101 | 2 | 0.981 | 0.418 |

The fixes found on this corpus are what take the run over the precision gate, so a second corpus has to confirm them. A range's lower end that is claimed as an absolute maximum is also caught without `range-position`: it shares a duplicate key with the true maximum on the same line, so the duplicate check sends both to review. The new check keeps the true maximum admitted.

**What each validator stops.** These are the extractions a validator alone kept out, each scored as if it had been admitted (`eval/results/boardrepo-ablation.json`):

| Validator | Would have been correct | Would have been wrong | Unparseable |
|---|---|---|---|
| qualifier-column | 1 | 11 | 0 |
| range-position | 0 | 5 | 0 |
| footnote-hold | 4 | 2 | 0 |
| confidence-routing | 28 | 3 | 0 |
| conditions | 10 | 0 | 0 |
| unit-present | 8 | 0 | 0 |
| numeric | 0 | 0 | 6 |
| unit-system | 0 | 0 | 3 |

Confidence routing, the condition parser and the unit-present check cost recall and stop few errors. The condition parser rejects ranges such as "TA = -40°C to +85°C". Of the 111 extractions kept out, 53 would have been correct, 33 wrong and 25 do not parse.

**Not certified.** The corpus has one labeller (Claude) and no second, one release set and no tagged hard cases, so the audit fails and no calibration record is written.

**Known reader limit.** On the IS61WV25616 supply-current table, small raised values (21, 10, 6 mA) are read as footnote markers and leave the line. That costs recall there, and the reader's superscript rule needs a follow-up.

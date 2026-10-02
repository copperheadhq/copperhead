# Proposal: ground-intake-extraction

## Why

The intake is now Copperhead's one datasheet extraction path. copperhead-cortex is frozen: it has no consumer, its PDF parsing was never built, and the intake had already re-implemented its extraction, registry and verdict engine. The intake therefore has to carry the rigor cortex was built for, and today it does not:

- **Quotes are checked against OCR output, not the document.** Every page goes through Sarvam, and a snippet is trusted when it occurs in Sarvam's text. OCR is itself a model, so a misread "0.3" that becomes "0.8" passes the snippet check, the number check and the export together. All four demo datasheets, including the "scanned" 2N3055, have full text layers that are never read.
- **The model writes the quote.** The extractor returns a free-text snippet, matched loosely (whitespace squashed, lower-cased, substring). It should only be able to point at text the core has already read.
- **Values lose their meaning.** A fact is one number or string with a unit: "3 6" mA, "1 100" nA and "VDD^1+0.3" are stored as extracted. MIN, TYP and MAX columns, test conditions and footnotes have no representation, and arithmetic is floating point.
- **Facts can leak between parts.** The registry holds one part, facts are keyed by parameter name alone, and on a key clash the stored fact wins. A fact persisted for one datasheet can decide a verdict about another.
- **Replay can serve the wrong output.** The extraction cache key is the PDF hash and the field list. It does not include the model, the prompt, or the pages. The manifest records the configured model rather than the one that ran, and no document hash.
- **Nothing measures accuracy.** There is no harness that scores extraction against labelled datasheets, so whether extraction can run without a person in the loop is still unknown.

cortex already solved most of the representation and checking problems in pure, tested, Apache-2.0 packages: exact decimals with SI units, condition sets, MIN/TYP/MAX qualifiers, a validator pipeline with reason codes, a corroboration ladder, a fail-closed verdict engine with condition coverage, and an evaluation harness with release gates. This change moves those packages into the intake, puts a deterministic text-layer reader in front of OCR, and makes the extractor cite evidence units that the core mints.

## What Changes

- **Knowledge core vendored from cortex.** The pure packages (core types and reason codes, exact decimals and units, numeric/qualifier/condition parsers, validators, ladder, verdict engine, segmenter, conformance kit, evaluation harness) are copied from cortex `origin/main` b4a45e8 into `intake/core/knowledge/`, with their tests, a provenance record and the Apache-2.0 notice. From then on the intake owns them.
- **Text layer first.** The server reads each selected page's text layer with pdf.js (already a dependency) and builds lines and table rows, each with a bounding box. Sarvam OCR runs only for pages without a usable text layer. Every page records which text it used.
- **Evidence units, not snippets.** The core mints an identified evidence unit per line or table row, with its text, header and footnote context, and bounding box. The extractor is given the units and returns, per field, the unit id, the value and unit as printed, the qualifier and the conditions. It never supplies text or coordinates.
- **Validation.** cortex's nine validators run on every extraction (lineage, numeric, unit system, qualifier, conditions, citation containment, revision authority, range invariants, duplicate reconciliation). The intake adds four:
  - a qualifier taken from the column the value sits in
  - the unit present in the cited unit or its header
  - number words and worded bounds ("nine", "at least")
  - the existing footnote hold

  Outcomes are ADMITTED, REVIEW_REQUIRED or REJECTED, with reason codes. Confidence only routes items to review; it never admits one.

- **Facts become readings.** A parameter holds readings, each with an exact decimal value, a qualifier, a condition set and its evidence unit. Field ranges such as supply voltage become MIN and MAX readings.
- **Registry per part and document.** Parameters are stored per part (manufacturer and part number) and per datasheet hash, never merged across parts. A correction is appended as a human reading, which the ladder marks verified.
- **One verdict engine.** cortex's engine replaces the intake's. It brings exact sums, guarantee qualifiers (worst case needs MAX or MIN) and condition coverage. Three gaps in it are closed:
  - a unit mismatch holds instead of throwing
  - the missing-condition policy is honoured
  - an unsupported operator holds

  It is extended with applied values from a change, and with absolute-maximum stress checks. Absolute-maximum ratings are compared only against a voltage or current a change applies, and never become design targets.

- **Cache and manifest.** Every cache key includes all the inputs that produced the entry: document hash, pages, text reader version, and extractor model, prompt and schema. Live mode no longer forces re-extraction, and running the extractor again is an explicit new pass. The manifest records the models that actually ran, the document hash, each page's text source, validator versions and fact versions, and it reproduces from canonical JSON.
- **Evaluation.** `npm run eval` scores the intake's extractor with cortex's harness and gates against a labelled corpus, offline from cached extractions. The demo datasheets and cortex's demo corpus are the first corpus.
- **UI.** The fact table shows each reading's qualifier, conditions, status, reason codes and text source. Clicking a reading highlights its evidence unit's box.

Out of scope (non-goals): cortex's world graph, query service, API, MCP server, cloud providers and multi-tenancy; automatic page location; layout guidance (the `add-layout-guidance-intake` change rebases onto this one); assembling the full 20 to 50 datasheet labelled corpus, which is data work tracked separately.

## Capabilities

### New Capabilities

- `source-text`: text-layer reading, the usable-layer test, OCR fallback and page marking, and evidence units with ids, context and bounding boxes.
- `extraction-validation`: extraction that cites evidence units, the validator pipeline and its outcomes, and the number, bound, qualifier and unit checks.
- `knowledge-core`: the vendored cortex packages, their provenance, exact decimals, condition sets, readings and the ladder.
- `extraction-evaluation`: the harness, the gates, the extractor adapter and offline evaluation.

### Modified Capabilities

- `datasheet-ingestion`: text layer before OCR; complete cache keys; no forced re-extraction.
- `fact-pipeline`: readings with qualifiers and conditions; provenance from evidence units; confidence as routing.
- `constraint-verdicts`: the cortex engine with applied values, stress checks and the closed gaps; a complete, canonical manifest.
- `registry-memory`: storage per part and document; corrections as human readings.
- `intake-ui`: readings, statuses and reason codes; click-to-source from evidence units.

## Impact

- New `intake/core/knowledge/` (about 3,200 lines of source and 1,400 of tests copied from cortex), `intake/core/text/` (text-layer reader, row builder, usable-layer test), and `intake/scripts/` additions (fixture re-keying, evaluation). pdf.js moves into server use; `fast-check` is added as a dev dependency.
- Rewritten: `core/model.ts`, `core/pipeline.ts`, `core/engine.ts` (replaced), `core/registry.ts`, `core/manifest.ts`, `core/fields.ts`, `core/units.ts` (replaced by the vendored units), `adapters/cache.ts`, `adapters/ingest.ts`, `adapters/extractor-common.ts`, `adapters/registry-store.ts`, the API routes, `app/page.tsx` and `components/PdfViewer.tsx`.
- Tests: most of the 75 existing tests are rewritten against the new model. GT-1 to GT-6 and the demo acceptance script keep their outcomes. The cached fixtures are regenerated once with a live extraction, because they cite snippets rather than evidence units.
- The demo registry (`data/`, gitignored) is reset to the new seed format. There is no user data to migrate.
- Implements RFC 17 §9.3 items 1 to 5, 7 and 8, and §5.3 and §5.5 for parameters, in the Copperhead RFC series.
- The repository root's NOTICE gains the cortex attribution.

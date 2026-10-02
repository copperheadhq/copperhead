# Demo corpus — NOT the golden corpus

This directory demonstrates the corpus format and exercises the harness
mechanics in CI against the stub provider. It is **single-labeled, four
documents, two vendors** — far below the SPEC §18 composition floor — so
`auditCorpus` reports it non-golden and the harness will never mint a
calibration record from it. That is by design.

## Building the real golden corpus (task 6.3, human part)

1. **Select 20–50 datasheets across ≥5 vendors**, mixing born-digital,
   scanned, photographed, and annotated sources. Do not commit the PDFs:
   reference them as `{ "kind": "reference", "sha256": "…" }` and keep the
   blobs in a private store; the runner hash-verifies fetched content.
2. **Write the analyzer field schema** per document (`fields`) — the same
   shape `POST /v1/documents/ingest` takes.
3. **Label twice, independently.** Two labelers each fill a `LabelSet`
   (`labels.a`, `labels.b`) without seeing each other's work. Values are
   decimal strings with units; conditions are datasheet-syntax strings
   (`"VIN = 3.6 V, TA = 25°C"`); every expected reading cites its page and a
   containing text fragment. Fields the document does not state are labeled
   `"ABSENT"` — those catch fabrication.
4. **Adjudicate.** Resolve disagreements into `labels.adjudicated` (the set
   the harness scores against). Disagreement rate is worth recording; high
   rates mean the field schema is ambiguous.
5. **Tag cases** (`caseTags`): every corpus needs `adversarial`,
   `missing-condition`, `typical-only`, and `conflict` documents.
6. **Split release sets** document-disjoint (e.g. `dev` / `holdout`), and add
   decision fixtures — including at least one `insufficientEvidence` fixture
   that must HOLD.
7. Run `auditCorpus` (or the CLI eval command) until the violation list is
   empty. Only then can a passing run mint a calibration record.

## Why the `llm-search` baseline arm cannot be scored against this corpus

The document text here is **fictional**: it exercises the pipeline, it is not
transcribed from the real datasheets. The demo `TPS62840` states an IQ of
0.033 / 0.060 mA; the real TI datasheet states 60 nA typ / 100 nA max.

That is fine for every arm that reads the document it is given (`cortex`,
`llm-document`) and fatal for the arm that goes and finds the real one: a
measured run of `llm-search` returned `100 nA MAX` cited to page 7 of the
actual datasheet — correct in the world, "wrong" against these labels.

So `llm-search` numbers are only meaningful on a corpus of **real** documents.
This is one more thing gated on the golden corpus (§18, task 6.4), not a
defect in the harness.

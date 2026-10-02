## ADDED Requirements

### Requirement: Datasheet ingestion from the text layer with OCR fallback

The system SHALL ingest a datasheet by:

1. reading the selected pages through the source-text capability: the text layer first, Sarvam Digitise only for pages without a usable text layer
2. minting evidence units
3. obtaining extractions from a `FactExtractor` port that cites those units
4. running every extraction through the extraction-validation capability

The ingest result SHALL report each page's text source and reader version, the extractor's model id as the extractor reported it, the prompt template hash, and every extraction's outcome with its reason codes.

#### Scenario: Readings with page and box (AC-1.1, AC-1.2)

- **WHEN** ingestion runs on a born-digital datasheet page with a field list
- **THEN** at least 4 readings are admitted or held for review, each with an exact value, a qualifier, its evidence unit, its page and its bounding box

#### Scenario: OCR only where needed

- **WHEN** a datasheet whose selected pages all have usable text layers is ingested
- **THEN** no Sarvam job is created

## MODIFIED Requirements

### Requirement: Content-hash extraction cache

The system SHALL cache each stage's output under a key holding every input that produced it:

- **text:** the document's sha256, the sorted page list and the reader version
- **OCR:** the document's sha256, the page list, the provider id, the language and the output format
- **extraction:** a digest of the evidence units given (their ids and text), a digest of the field requests, the extractor's model id, the prompt template hash and the output schema version

Each entry SHALL store its key material and SHALL be served only when every part matches. The cache SHALL be consulted before any Sarvam job or extractor call. Live ingestion SHALL NOT force re-extraction. Extracting again for the same inputs SHALL be an explicit action that records a new pass beside the previous one and reports the readings that differ.

#### Scenario: Repeat ingestion of the same document

- **WHEN** a datasheet whose inputs already have cached results is ingested again
- **THEN** the cached results are returned, and no Sarvam job or extractor call is made

#### Scenario: Different model

- **WHEN** the same document and pages are ingested with a different extractor model than the cached entry records
- **THEN** the cached extraction is not served, and a new extraction is made and cached under its own key

#### Scenario: Explicit re-extraction

- **WHEN** a person asks for the same inputs to be extracted again
- **THEN** the new pass is recorded beside the old one, the readings that differ are reported, and the old pass is not overwritten

## REMOVED Requirements

### Requirement: Datasheet ingestion via Sarvam Digitise and a fact-extractor port

**Reason**: Replaced by "Datasheet ingestion from the text layer with OCR fallback". Sarvam Digitise is no longer the source of every page's text, and the extractor no longer returns snippets.
**Migration**: Pages with a usable text layer are read from the PDF. OCR output is used only for the others, and is marked as such. Extractors return evidence unit ids in place of snippets.

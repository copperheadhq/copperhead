## ADDED Requirements

### Requirement: Evaluation harness and gates

`npm run eval -- --corpus <dir>` SHALL score the intake's extraction against a labelled corpus in the vendored corpus format, reading each document's PDF through the intake's text reader, and SHALL report every gate:

- field precision at least 0.98
- condition F1 at least 0.95
- citation accuracy 1.0, scored on the cited unit's page and text
- no wrong reading reported with confidence 0.9 or above
- decision accuracy 1.0
- no false APPROVE
- every insufficient-evidence fixture held
- cost to verify under ten minutes per datasheet

It SHALL also report field recall, and, per validator, how many extractions it rejected or sent to review. A calibration record SHALL be written only when the corpus passes the corpus audit and every gate passes.

#### Scenario: Gate failure reported

- **WHEN** an evaluation run admits one reading whose value differs from its adjudicated label
- **THEN** field precision is reported below 1.0 with the field named, and the run's result lists each gate as passed or failed

#### Scenario: Small corpus does not certify

- **WHEN** every gate passes on a corpus of six documents from three vendors
- **THEN** no calibration record is written, and the report states that the corpus audit failed and why

### Requirement: Extractor adapter

The intake's extractors SHALL be usable by the harness through the vendored extraction provider interface, which takes a list of evidence units and the field requests and returns extractions citing unit ids. The same adapter SHALL run the conformance kit's fixtures, including its prompt-injection and forged-evidence fixtures.

#### Scenario: Forged evidence

- **WHEN** the conformance kit's forged-evidence fixture is run through the intake's extractor
- **THEN** every extraction citing text that the unit does not contain is REJECTED

### Requirement: Offline evaluation

Evaluation SHALL run from cached extractions with no network call by default. With `--live` it SHALL run the extractor and write its output to the cache under the complete keys of the datasheet-ingestion capability.

#### Scenario: Offline run

- **WHEN** `npm run eval -- --corpus fixtures/eval` runs without `--live`
- **THEN** no network call is made, and a document without a cached extraction is reported as not evaluated rather than scored

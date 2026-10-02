## ADDED Requirements

### Requirement: Extraction cites evidence units

The extractor SHALL receive the evidence units of the selected pages with their ids and the field requests, and SHALL return, per extracted field:

- the field key and the `evidenceId` of the unit holding the value
- the value and unit exactly as printed
- the qualifier
- the raw conditions
- a footnote flag
- a confidence in [0, 1]

The output schema SHALL NOT contain snippet text or coordinates. An extraction naming an id that is not among the units given SHALL be REJECTED with `EVIDENCE_ID_INVALID`.

#### Scenario: Unknown evidence id

- **WHEN** the extractor returns a field citing `ev-841138b7-p9-l4` and page 9 was not selected
- **THEN** the extraction is REJECTED with `EVIDENCE_ID_INVALID` and no reading is created

#### Scenario: Box from the unit

- **WHEN** an extraction citing a unit on page 3 is admitted
- **THEN** its reading's bounding box is the unit's bounding box, and nothing in the extractor's output contributed coordinates

### Requirement: Validator pipeline

Every extraction SHALL pass through these validators, in order, each recording its name and version:

- lineage
- numeric
- unit system
- qualifier
- qualifier column
- conditions
- citation containment
- unit present
- revision authority
- footnote hold

Admitted readings of one parameter SHALL then be checked for range invariants (MIN ≤ TYP ≤ MAX within a condition group) and reconciled for duplicates. The outcome of an extraction SHALL be exactly one of:

- ADMITTED
- REVIEW_REQUIRED, with reason codes
- REJECTED, with reason codes

Only ADMITTED readings SHALL be usable by a verdict. REJECTED extractions SHALL be kept in the ingest record with their reasons.

#### Scenario: Value not in the cited unit

- **WHEN** an extraction reports `0.8` citing a unit whose text and context do not contain `0.8`
- **THEN** the extraction is REJECTED with `CITATION_NOT_CONTAINED`

#### Scenario: Range invariant broken

- **WHEN** a parameter's admitted readings in one condition group have MIN 5 and MAX 3
- **THEN** the conflict is reported as `FACT_CONFLICT` and both readings require review

### Requirement: Qualifier from the column

When an evidence unit's context holds a header row naming MIN, TYP, MAX, NOM or an absolute maximum, the qualifier an extraction claims SHALL match the header of the column its value sits in. A mismatch SHALL be REJECTED with `QUALIFIER_COLUMN_MISMATCH`.

#### Scenario: Typical value reported as maximum

- **WHEN** a row reads `Supply current | 3 | 6 | mA` under the header `PARAMETER | TYP | MAX | UNIT` and the extraction reports 3 mA as MAX
- **THEN** the extraction is REJECTED with `QUALIFIER_COLUMN_MISMATCH`

#### Scenario: Correct column

- **WHEN** the same extraction reports 6 mA as MAX
- **THEN** the qualifier column check passes

### Requirement: Unit present in the citation

The unit an extraction reports SHALL occur in its evidence unit's text or header context, compared after Unicode compatibility normalisation, so that µ and u match. Otherwise the extraction SHALL be REJECTED with `UNIT_NOT_CONTAINED`.

#### Scenario: Unit invented

- **WHEN** an extraction reports `45 kOhm` citing a unit that reads `45` under a header with no unit
- **THEN** the extraction is REJECTED with `UNIT_NOT_CONTAINED`

### Requirement: Number words and worded bounds

The parsers SHALL read the number words zero to twenty as their numerals, and SHALL read worded bounds:

- "at least", "minimum" and "no less than" bound from below
- "at most", "maximum", "up to", "within", "less than" and "no more than" bound from above

Citation containment SHALL accept a numeral whose word form occurs in the cited text. A bound an extraction states SHALL match the wording of its citation. A citation with no bound wording, or with both, SHALL ground the value but not the bound, and the extraction SHALL require review.

#### Scenario: Number word

- **WHEN** an extraction reports a minimum of 9 citing "Use at least nine 0.3-mm vias under the exposed pad."
- **THEN** containment and the bound both pass

#### Scenario: Reversed bound

- **WHEN** an extraction reports a minimum of 2 mm citing "Keep the trace within 2 mm of the pin."
- **THEN** the extraction is REJECTED, because "within" bounds from above

### Requirement: Confidence routes and never admits

The extractor's confidence SHALL be used only to route: an extraction that every validator admits but whose confidence is below 0.75 SHALL be REVIEW_REQUIRED. Confidence SHALL NOT admit an extraction, raise a status, or appear as the confidence of a verdict.

#### Scenario: Low confidence

- **WHEN** an extraction passes every validator with confidence 0.40
- **THEN** it is REVIEW_REQUIRED, and it is not usable by a verdict until a person confirms it

#### Scenario: High confidence does not override a validator

- **WHEN** an extraction with confidence 0.99 fails citation containment
- **THEN** it is REJECTED

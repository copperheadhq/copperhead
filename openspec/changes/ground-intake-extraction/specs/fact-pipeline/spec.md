## MODIFIED Requirements

### Requirement: Fact typing and unit normalization

The system SHALL map each admitted extraction to a parameter of the part, keyed by its canonical key, as a reading with an exact decimal measurement, its unit and SI value, its qualifier and its condition set, as pure functions with no I/O. A value printed as a range SHALL become separate MIN and MAX readings. A field that no constraint consumes SHALL still be stored.

#### Scenario: Milliamp leakage normalized to microamps (AC-2.1)

- **WHEN** an admitted extraction reads "Input leakage current" as 0.033 mA, MAX
- **THEN** the parameter `pin_input_leakage_uA` holds a MAX reading of exactly 0.033 mA, whose SI value is 0.000033 A, and comparing it with a limit in uA gives 33 uA

#### Scenario: Unconsumed fields are stored without crashing (AC-2.2)

- **WHEN** an extraction is admitted for a parameter that no registry constraint consumes
- **THEN** the reading is stored but not required for any verdict, and evaluation does not crash

### Requirement: Provenance on every fact

Every reading SHALL carry the evidence unit it was read from: the document's sha256, the page, the unit's id, its text, its context, its bounding box and the page's text source. The type system SHALL make an admitted reading without an evidence unit holding text and a bounding box unrepresentable.

#### Scenario: Reading traced to its unit (AC-3.1)

- **WHEN** an admitted reading is used in a verdict
- **THEN** the verdict cites the reading's evidence unit by id, page and bounding box, and the unit's text contains the reading's value as printed

### Requirement: Confidence gating

The system SHALL treat the extractor's confidence as routing only. An extraction that every validator admits but whose confidence is below `CONFIDENCE_THRESHOLD = 0.75` SHALL be REVIEW_REQUIRED. An extraction flagged by a datasheet footnote qualifier SHALL be REVIEW_REQUIRED unless the footnote's text is carried in its conditions. Confidence SHALL never admit an extraction that a validator rejected or sent to review.

#### Scenario: Low confidence becomes review (AC-4.1)

- **WHEN** an extraction passes every validator with confidence below 0.75
- **THEN** it is REVIEW_REQUIRED, and it cannot decide a verdict

#### Scenario: Footnote qualifier becomes review

- **WHEN** an extracted value is flagged by a footnote qualifier whose text is not carried in its conditions
- **THEN** it is REVIEW_REQUIRED regardless of confidence

## REMOVED Requirements

### Requirement: Provenance stitching

**Reason**: Snippets are gone. Extractions cite evidence units that the core minted, so there is no snippet to verify and no region to locate.
**Migration**: Citation containment and the other validators of the extraction-validation capability replace snippet verification. Bounding boxes come from evidence units.

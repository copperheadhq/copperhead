## MODIFIED Requirements

### Requirement: Click-to-source highlighting

The UI SHALL render each reading with its qualifier, value and unit, conditions, status and text source. Clicking a reading SHALL scroll the datasheet view to its page and highlight its evidence unit's bounding box. The viewer SHALL NOT locate regions by matching text.

#### Scenario: Click a sourced reading (AC-10.1)

- **WHEN** the user clicks a rendered reading
- **THEN** the datasheet view scrolls to the reading's page and highlights its evidence unit's bounding box

### Requirement: HOLD facts are visually distinct

The UI SHALL render REVIEW_REQUIRED and REJECTED extractions visually distinct from admitted readings, labelled "review" or "rejected", with their reason codes. It SHALL mark verified canonical values and the readings read by OCR.

#### Scenario: Review rendering (AC-10.2)

- **WHEN** an extraction that requires review is rendered
- **THEN** it is visually distinct (for example amber), labelled "review", and shows its reason codes

#### Scenario: OCR marked

- **WHEN** a reading from a page read by OCR is rendered
- **THEN** it is marked as read by OCR

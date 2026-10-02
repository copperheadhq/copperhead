## MODIFIED Requirements

### Requirement: Trusted fact persistence

When a verdict is APPROVE or REFUSE, the system SHALL write the admitted readings used to the registry under the evaluated part (manufacturer and part number) and the document they were read from (its sha256), using an atomic write (temp file then rename), so a crashed write cannot corrupt the registry. A reading SHALL belong to exactly one part and one document.

#### Scenario: Readings persisted under their part (AC-8.1)

- **WHEN** a part's evaluation completes with APPROVE or REFUSE
- **THEN** the admitted readings used are written to the registry under that part and document, with their evidence units

### Requirement: Fact reuse without re-extraction

For a subsequent change on a part whose readings are already stored, the system SHALL reuse that part's stored readings and SHALL NOT call Sarvam or the extractor for them. A verdict about one part SHALL never use another part's readings.

#### Scenario: Second change on the same part (AC-8.2)

- **WHEN** a second change on the same part is evaluated
- **THEN** the stored readings are reused and no Sarvam job or extractor call is made

#### Scenario: No leakage between parts

- **WHEN** the registry holds a `quiescent_current_uA` reading for the LM555 and a change on the ESP32-WROOM-32 is evaluated
- **THEN** the LM555 reading is not used, and the verdict holds unless the ESP32's own reading is admitted

### Requirement: Correction propagation

When a person corrects a value, the system SHALL append a reading whose method is human, with the person's name as contributor and the corrected value. It SHALL keep the extracted reading beside it, recompute the canonical value through the ladder (status `verified`), recompute the affected verdict live, and update the manifest, without any re-extraction.

#### Scenario: Corrected fact recomputes verdict (AC-9.1)

- **WHEN** a person corrects a mis-read value and saves
- **THEN** a human reading is appended, the extracted reading is kept, the canonical value is `verified`, and the verdict and manifest update with no extraction

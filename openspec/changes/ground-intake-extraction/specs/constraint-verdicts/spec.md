## MODIFIED Requirements

### Requirement: Constraint registry loading

The system SHALL load the board's constraints from the registry. Each constraint SHALL have:

- an id and a human description
- a kind: `budget_sum`, `max`, `min` or `equality`
- a limit as an exact decimal with its unit
- the parameter keys it affects
- its source
- optional conditions
- a policy: `WORST_CASE` or `TYPICAL_OK`
- for a `max` constraint, an optional `stressFrom` naming a parameter whose ABS_MAX reading also bounds an applied value

A constraint of an unknown kind, a limit without a known unit, or any other malformed entry SHALL fail the load with a typed error.

#### Scenario: Valid registry parses (AC-5.1)

- **WHEN** the seed registry is loaded
- **THEN** a `budget_sum` constraint (sleep current, limit 25 uA, WORST_CASE) and a `max` constraint (rail voltage, limit 3.3 V, `stressFrom: abs_max_vin_V`) parse

#### Scenario: Malformed registry fails closed (AC-5.2)

- **WHEN** a malformed registry is loaded
- **THEN** the system reports the error and refuses to evaluate; it never approves by default

### Requirement: Deterministic fail-closed verdict engine

The system SHALL evaluate a change against the evaluated part's admitted readings and the constraints, as a pure function (no I/O, no clock read, no randomness, no model), producing a verdict with a decision, a reason, reason codes, the cited readings and constraint, the computation in exact decimals, and the rule version. Terms SHALL be the part's parameters, or values the change applies.

Under `WORST_CASE`, `max` and `budget_sum` SHALL use MAX readings, `min` SHALL use MIN readings, and `equality` SHALL use NOM readings; under `TYPICAL_OK`, TYP or NOM readings SHALL be accepted. A reading SHALL be used only when its conditions cover the requirement's. An ABS_MAX reading SHALL be used only by a `stressFrom` check, which compares a value the change applies with both the reading and the rule's limit.

The verdict SHALL be HOLD, never APPROVE or REFUSE, when any of the following holds; each case names its reason code:

| Condition | Reason code |
|---|---|
| A term has no admitted reading | `EVIDENCE_MISSING` |
| No reading carries the required qualifier | `GUARANTEE_UNAVAILABLE` |
| A reading's status is disputed or frozen | `FACT_CONFLICT` |
| Revisions of the document disagree | `REVISION_CONFLICT` |
| No reading's conditions cover the requirement | `CONDITION_NOT_COVERED` |
| The dimensions of a reading and a limit differ | `DIMENSION_MISMATCH` |
| The constraint kind is unknown | `UNSUPPORTED_OPERATOR` |
| No term applies | `SCOPE_EMPTY` |

#### Scenario: Budget refusal (AC-6.1)

- **WHEN** the change "add 100k pull-up" is evaluated against a 25 uA `budget_sum` and the part's MAX input leakage reading is 33 uA
- **THEN** the decision is REFUSE with `BUDGET_EXCEEDED`, the computation shows 33 uA against 25 uA, and the leakage reading and the sleep budget are cited

#### Scenario: Abs-max refusal (AC-6.2)

- **WHEN** a change applies 5 V to a part whose ABS_MAX input voltage reading is 3.6 V, under a `max` constraint with `stressFrom` and a 5 V limit
- **THEN** the decision is REFUSE, computed as 5 V against 3.6 V, citing the ABS_MAX reading and the rule

#### Scenario: Approval within constraints (AC-6.3)

- **WHEN** a change within all constraints is evaluated with admitted readings whose conditions cover the requirement
- **THEN** the decision is APPROVE with `REQUIREMENT_SATISFIED`

#### Scenario: Determinism (AC-6.4)

- **WHEN** identical inputs are evaluated 100 times
- **THEN** every verdict is byte-identical

#### Scenario: Reading under review forces HOLD (AC-4.2)

- **WHEN** the only reading for a deciding term is REVIEW_REQUIRED
- **THEN** the decision is HOLD with `EVIDENCE_MISSING`, and the reason names the parameter to re-check

#### Scenario: Typical value cannot guarantee a worst case

- **WHEN** a `WORST_CASE` budget's term has only a TYP reading
- **THEN** the decision is HOLD with `GUARANTEE_UNAVAILABLE`

#### Scenario: Unit dimension mismatch holds

- **WHEN** a constraint's limit is in volts and its term's reading is in amperes
- **THEN** the decision is HOLD with `DIMENSION_MISMATCH`, and no exception escapes the engine

### Requirement: Cited refusal with proposed fix

A REFUSE verdict SHALL carry a one-sentence engineer-grade reason naming the measured value, the limit and the exact deviation, the reason codes, the cited readings with their evidence units, and a specific, deterministic `proposedFix`.

#### Scenario: Refusal content (AC-7.1)

- **WHEN** a REFUSE verdict is rendered
- **THEN** the reason names the value, the limit and the exact deviation in one sentence, and `proposedFix` is present and specific (for example, use the MCU internal pull-up)

### Requirement: Verification manifest export

The system SHALL export, for any completed verdict, a manifest containing:

- the timestamp (injected by the caller) and a decision run id
- the part, the change and the checks run
- the document's sha256 and revision
- each page's text source and reader version
- the extractor model as the ingest reported it, and the OCR model when a page used OCR
- the prompt template hash and the validator versions
- the fact versions used
- the verdict with its reason codes and rule version

#### Scenario: Manifest download (AC-11.1)

- **WHEN** the user exports after any completed verdict
- **THEN** a manifest downloads holding the document sha256, the models that actually ran, the fact versions used and the verdict

#### Scenario: Manifest reproducibility

- **WHEN** the engine is re-run on the readings, constraints and change stored in a manifest
- **THEN** it produces a verdict identical to the manifest's, compared as canonical JSON with sorted keys

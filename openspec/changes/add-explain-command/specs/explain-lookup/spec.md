# explain-lookup — Delta Spec

## ADDED Requirements

### Requirement: Query resolution order
`explain` SHALL resolve `query` in this order: `REF.PIN` (pin number or pin name), exact refdes, exact net name, then a pin name that belongs to exactly one part. Matching SHALL be case-insensitive. A pin name that belongs to more than one part SHALL fail and tell the caller to use `REF.PIN`. An empty query SHALL fail with a usage hint.

#### Scenario: Pin by number
- **WHEN** the query is `R2.1` on the open-key fixture
- **THEN** the hit kind is `pin`, the net is `KEY_DAH`, and the ref is `R2`

#### Scenario: Pin by name
- **WHEN** the query is `U1.GPIO14`
- **THEN** the hit kind is `pin` and the net is `KEY_DAH`

#### Scenario: Unique pin name
- **WHEN** the query is `GPIO14` and only U1 has that pin name
- **THEN** the hit kind is `pin` and the ref is `U1`

### Requirement: Schematic is the source of truth
A part hit SHALL include value, footprint, library id, sheet, and every pin with its net from the schematic. A net hit SHALL list attached pins. Doc rows from BOM.md and PINOUT.md, and other markdown mentions under `docs/`, MAY decorate the hit and SHALL NOT override schematic fields.

#### Scenario: Part hit carries schematic pins
- **WHEN** `U1` is explained after `copperhead init` on the open-key fixture
- **THEN** the hit includes the ESP32-S3-MINI value and a GPIO14 pin on KEY_DAH

### Requirement: Suggestions on miss
When no hit is found, the command SHALL return nearby refdes and net names (prefix or substring, at most five) and SHALL NOT throw.

#### Scenario: Nearby net suggested
- **WHEN** the query is `KEY_DAHX` on the open-key fixture
- **THEN** `ok` is false and `suggestions` includes `KEY_DAH`

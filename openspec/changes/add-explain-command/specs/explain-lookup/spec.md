# explain-lookup — Delta Spec

## ADDED Requirements

### Requirement: Query resolution order
`explain` SHALL resolve `query` in this order: `REF.PIN` (pin number or pin name), exact refdes, exact net name, then a pin name that belongs to exactly one part. Matching SHALL be case-insensitive. A `REF.PIN`-shaped query whose part or pin does not exist SHALL fall through to the later steps and SHALL report the missing part or pin only when nothing else resolves. A pin name that belongs to more than one part, or to more than one pin of one part, SHALL fail and tell the caller to use `REF.PIN`; it SHALL NOT report that nothing is named. A `REF.PIN` query that matches several pins by name on different nets SHALL fail and ask for the pin number. An empty query SHALL fail with a usage hint.

#### Scenario: Pin by number
- **WHEN** the query is `R2.1` on the open-key fixture
- **THEN** the hit kind is `pin`, the net is `KEY_DAH`, and the ref is `R2`

#### Scenario: Pin by name
- **WHEN** the query is `U1.GPIO14`
- **THEN** the hit kind is `pin` and the net is `KEY_DAH`

#### Scenario: Unique pin name
- **WHEN** the query is `GPIO14` and only U1 has that pin name
- **THEN** the hit kind is `pin` and the ref is `U1`

#### Scenario: Dotted net name
- **WHEN** the query is `VDD1.8`, no part is named `VDD1`, and a net is named `VDD1.8`
- **THEN** the hit kind is `net` and the name is `VDD1.8`

#### Scenario: Pin name repeated on one part
- **WHEN** the query is `SHIELD` and only J1 has pins with that name, on pins S1 and S2
- **THEN** `ok` is false and the error names J1 pins S1 and S2 and asks for `REF.PIN`

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

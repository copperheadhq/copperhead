## ADDED Requirements

### Requirement: Vendored core with provenance

The intake SHALL hold the pure packages copied from copperhead-cortex at commit b4a45e8 under `intake/core/knowledge/`: types and reason codes, decimal, parsers, validators, ladder, verdict, segment, conformance and eval. Their tests SHALL move with them and pass. `intake/core/knowledge/PROVENANCE.md` SHALL record the source commit, every copied path, and every change made in the copy, and the repository NOTICE SHALL carry the cortex attribution. No module under `intake/core/` SHALL import a vendor SDK, `node:fs`, or Next.js, and the verdict module SHALL import only the types and decimal modules; a test SHALL enforce both rules.

#### Scenario: Ported tests

- **WHEN** the intake's test suite runs
- **THEN** the verdict engine and validator tests copied from cortex run and pass, including the 100-run byte-identical output test

#### Scenario: Boundary rule

- **WHEN** a module under `intake/core/knowledge/verdict/` imports the parsers
- **THEN** the boundary test fails

### Requirement: Exact decimals with units

Every measured value SHALL be held as an exact decimal string with its unit and its SI value, parsed and compared without floating point. Units SHALL cover current, voltage, frequency, resistance, power, capacitance, inductance, time, charge, temperature in degrees Celsius, and percent, with the prefixes p, n, u or µ, m, k, M and G. An unknown unit SHALL fail with `UNIT_UNKNOWN`, and a comparison across dimensions SHALL fail with `DIMENSION_MISMATCH`.

#### Scenario: Sum without rounding error

- **WHEN** 0.1 uA and 0.2 uA are summed
- **THEN** the result is exactly 0.3 uA

#### Scenario: Prefixed resistance

- **WHEN** the value `45` with the unit `kΩ` is parsed
- **THEN** it is 45 kΩ with an SI value of 45000 ohm

### Requirement: Readings with qualifiers and conditions

A parameter SHALL hold readings, each with an exact measurement, a qualifier (MIN, TYP, MAX, NOM or ABS_MAX), a condition set, the evidence unit it was read from, its contributor and method, the validators it passed, and the time it was added. Conditions SHALL keep the supply voltage, temperature, mode, frequency and load as parsed, and footnotes by reference. A range printed in one cell SHALL become separate MIN and MAX readings.

#### Scenario: Range split

- **WHEN** a supply voltage is printed as "4.5 to 16 V" in one cell under a MIN and MAX header pair
- **THEN** the parameter holds a MIN reading of 4.5 V and a MAX reading of 16 V, each citing the same unit

### Requirement: Ladder statuses and human readings

The ladder SHALL compute each parameter's canonical value per qualifier and condition group from its readings:

- `verified` when a person's reading or a tool cross-check supports it
- `disputed` when clusters of readings disagree with no dominant cluster, and then frozen
- `corroborated` when readings from two or more distinct documents agree
- `extracted` otherwise

A correction SHALL be appended as a reading whose method is human and whose contributor is the person's name; nothing SHALL be overwritten.

#### Scenario: Correction verifies

- **WHEN** a person corrects an extracted reading of 3 V to 3.6 V
- **THEN** both readings are kept, and the canonical value is 3.6 V with status `verified`

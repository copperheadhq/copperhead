## ADDED Requirements

### Requirement: Prompt

The proposer SHALL build its prompt from block-map context bundles and a fixed role guide only, and the
same bundles SHALL give the same prompt.

#### Scenario: Deterministic prompt

- **WHEN** the prompt is built twice from the same bundles
- **THEN** the two prompts are identical and hold the bundles

### Requirement: Reply parsing

The proposer SHALL keep a proposed block only for a part it asked about and with a known kind, and in it
only known roles naming fitted parts listed in that part's bundle; everything else SHALL be dropped and
listed in the bindings file's header. A reply without a blocks list SHALL propose nothing.

#### Scenario: A part outside the bundle

- **WHEN** the reply names C99 as an input capacitor and C99 is not in the bundle
- **THEN** C99 is dropped and the drop is listed

### Requirement: The bindings file

The proposer SHALL write a bindings file v1 with `proposedBy` naming the model, the proposer version and
the prompt hash, so that block-map treats it as a model's proposal and checks every part before use.

#### Scenario: Applied by block-map

- **WHEN** block-map is run with the proposer's file
- **THEN** each role it applies records that it was proposed and checked

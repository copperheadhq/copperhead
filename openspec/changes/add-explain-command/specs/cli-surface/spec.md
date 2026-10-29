# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `explain` command
The CLI SHALL provide `copperhead explain <query>`, which looks up a refdes, net, or pin in the configured schematic and prints a human-readable summary. The command SHALL be deterministic, LLM-free, and network-free, and SHALL NOT require `kicad-cli`. With `--json` it SHALL emit `{ ok: true, hit }` or `{ ok: false, error, suggestions }`. A resolved query SHALL exit 0; an unknown query, a missing schematic, or a read error SHALL exit 1 with no stack trace; under `--json` a read error SHALL still print `{ ok: false, error, suggestions }`. The REPL SHALL expose the same lookup as `/explain <query>`.

#### Scenario: Refdes lookup
- **WHEN** `copperhead explain U1` runs on the open-key fixture
- **THEN** the output names U1, its value, and the GPIO14 pin on KEY_DAH, and the exit code is 0

#### Scenario: Net lookup under --json
- **WHEN** `copperhead --json explain GND` runs on a configured schematic
- **THEN** the JSON has `ok: true`, `hit.kind` is `"net"`, and `hit.name` is `"GND"`

#### Scenario: Unknown query
- **WHEN** `copperhead explain NOPE` runs on the open-key fixture
- **THEN** the process exits 1 and the error names `NOPE`

#### Scenario: REPL slash command
- **WHEN** a REPL session receives `/explain U1`
- **THEN** it prints the same lookup as `copperhead explain U1` and does not start an agent turn

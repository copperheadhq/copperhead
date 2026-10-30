# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `capabilities` command
The CLI SHALL provide `copperhead capabilities`, which performs capability discovery and reports the supported wire protocol identifier, CLI version, registered commands, active features, and installed tool versions. The command SHALL honor the global `--json` option and print machine-readable JSON. The command SHALL require no git repository and no model credentials.

#### Scenario: Help lists capabilities command
- **WHEN** `copperhead --help` is run
- **THEN** the output lists `capabilities` with a one-line description alongside existing commands

#### Scenario: Capabilities with global --json
- **WHEN** `copperhead capabilities --json` is invoked
- **THEN** stdout carries a well-formed JSON capability document and exits 0

#### Scenario: Capabilities without --json
- **WHEN** `copperhead capabilities` is invoked without `--json`
- **THEN** stdout carries a human-readable capability summary and exits 0

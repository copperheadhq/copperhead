# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: Opt-in `check --power` CLI surface

`copperhead check --power` SHALL invoke `runPowerIntegrity` without LLM or network calls, skipping with an install hint when the binary is absent unless `--strict-power` is passed.

#### Scenario: Missing binary skips with install hint unless `--strict-power`

- **WHEN** `copperhead check --power` runs without `ki-pida` installed
- **THEN** `check` reports `power.skipped: true` with an install hint, or fails when `--strict-power` is set

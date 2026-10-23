# power-integrity — Delta Spec

## ADDED Requirements

### Requirement: Fail-closed DC power-integrity telemetry and budget verification

`powerIntegrityChecker` SHALL validate adapter JSON telemetry at the boundary, enforce a subprocess timeout, support hierarchical `/`-prefixed rail keys, and warn when telemetry categories lack configured budgets.

#### Scenario: Empty or snake_case telemetry fails closed

- **WHEN** the external tool outputs `{}` or snake_case fields (`ir_drop_v`)
- **THEN** `validatePidaTelemetry` throws `PidaToolError` and never reports `ok: true`

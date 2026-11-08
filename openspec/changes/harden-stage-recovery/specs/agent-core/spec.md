# agent-core delta spec

## ADDED Requirements

### Requirement: Structured refusal blockers

The `finish` tool SHALL accept, with outcome `refuse`, an optional `blockers` array. Each blocker SHALL have a `kind`; for kind `constraint-conflict` it SHALL name a `constraint` key, the `required` value and the `found` candidate (part or value) that fails it, in prose a reader can act on. Before a blocker counts, the loop SHALL verify its `constraint` key exists in the constraint registry; a blocker naming an unregistered key SHALL be kept only as prose in the refusal summary, never as a verified blocker. The refused run result SHALL carry the verified blockers to the caller, and the transcript's `run-refused` event and the run summary SHALL list every blocker with its verification status.

#### Scenario: Verified conflict is carried to the caller (AC-18.1)

- **WHEN** the agent calls `finish` with outcome `refuse` and a blocker `{kind: "constraint-conflict", constraint: "protection.precharge_bypass", required: "≥ 16 A", found: "G5Q-1A4 relay, 6 A"}` and `protection.precharge_bypass` is a registered constraint
- **THEN** the run ends refused, its result lists that blocker as verified, and the summary's refusal section names the key, the required value and the failing candidate

#### Scenario: Unregistered key does not stop anything (AC-18.2)

- **WHEN** a refusal blocker names a constraint key absent from the registry
- **THEN** the run result carries no verified blocker, the summary records the claim as unverified prose, and the caller treats the refusal as it would one without blockers

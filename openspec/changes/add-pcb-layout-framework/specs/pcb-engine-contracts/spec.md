# pcb-engine-contracts — Delta Spec

## ADDED Requirements

### Requirement: Plugin manifests and contracts
Placers, routers, and checkers SHALL connect through the versioned contracts of RFC §8.1, §9.1, and §10.1. Every manifest SHALL declare id, version, adapter version, license, input and output schema versions, determinism (`deterministic` | `seeded` | `nondeterministic`), execution mode (`library` | `process` | `container` | `remote`), network requirement (`none` | `optional` | `required`), and capabilities. Contracts SHALL be published as JSON Schema generated from the TypeScript types.

#### Scenario: Manifest validates before use (AC-17.3)
- **WHEN** a plugin's manifest omits `networkRequirement` or declares an unknown schema version
- **THEN** the registry rejects the plugin at discovery with the missing or unknown field named

### Requirement: Fail-closed capability negotiation
An engine SHALL be eligible for a job only if it supports every hard constraint in scope, the layer count and via types, its license is permitted by runtime policy, its resource needs fit the job limits, and its adapter can losslessly represent the required geometry. An ineligible job SHALL return `UNSUPPORTED`, never a degraded attempt.

#### Scenario: Unsupported constraint is refused, not approximated (AC-17.4)
- **WHEN** a routing job carries a hard differential-pair constraint and every eligible router's manifest declares `differentialPairs: false`
- **THEN** the run returns `UNSUPPORTED` naming the constraint and no router is invoked

### Requirement: Isolation and provenance
Engines with execution mode `process`, `container`, or `remote` SHALL run outside the copperhead process against a temporary copy of the snapshot, with the source project unreachable to them. Every invocation SHALL be recorded with engine id, version, adapter version, arguments, seed, exit status, wall-clock, and peak memory where measurable. GPL-licensed engines SHALL run out of process only. Secrets SHALL NOT reach an engine's environment.

#### Scenario: Provenance on every run
- **WHEN** any engine runs
- **THEN** the run record carries every field above and the transcript names the engine and version

### Requirement: Execution modes
The runner SHALL support `single`, `race`, `staged`, and `ensemble` execution over eligible engines from one snapshot; `portfolio` SHALL NOT exist until benchmark data justifies it. A race SHALL cancel losers through the plugin's `cancel` when present and SHALL record every candidate produced.

#### Scenario: Race keeps every candidate
- **WHEN** two routers race and both complete
- **THEN** both candidates are verified and scored, and the ranking records which won and why

### Requirement: Network policy on the check path
No engine whose manifest declares `networkRequirement: required` SHALL be invocable from anything reachable by `copperhead check`; the `check` module graph SHALL NOT import any engine wrapper.

#### Scenario: check never reaches a remote engine (AC-17.5)
- **WHEN** the transitive import graph of `src/commands/check.ts` is scanned
- **THEN** no wrapper under `src/pcb/engines/` and nothing under `src/pcb/agent/` is present

### Requirement: Wrapped engines, none copperhead-authored in production
v1 SHALL ship `router-freerouting` (DSN/SES, out of process), `router-kicad-tools-astar`, `placer-fixed`, `placer-pyplacer`, `placer-kicad-tools-physics`, `placer-kicad-tools-evolutionary`, and `placer-layout-reuse`. `router-reference` and `placer-reference` SHALL be marked `harnessOnly` in their manifests and SHALL be ineligible for production jobs. A copperhead-authored production placer SHALL NOT be built unless the B2 decision gate (RFC §13.5) records that every wrapped engine fails more than 30% of applicable hard intent constraints.

#### Scenario: Reference engines are fixtures only
- **WHEN** `copperhead pcb route` is run without `--allow-harness-engines`
- **THEN** `router-reference` is not eligible and the report says so

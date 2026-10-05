# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `check` is deterministic and LLM-free
`copperhead check` SHALL run ERC, DRC, and the doc-drift check, exit non-zero if any violation exists, and make zero LLM/network calls, completing in under 60 seconds on the test fixture. `copperhead verify` SHALL be an alias with identical behavior. With `--fab`, `check` SHALL additionally run the fabrication release gate (routing completeness, BOM readiness, schematic-to-PCB match, output freshness, documentation presence) under the same zero-LLM, zero-network, 60-second contract; `--strict` SHALL escalate fab-gate warnings to failures. Without `--fab`, behavior SHALL be unchanged.

#### Scenario: verify alias
- **WHEN** `copperhead verify` is run
- **THEN** it behaves identically to `copperhead check`, and `--help` lists `verify` as an alias of `check`

#### Scenario: Clean fixture passes (AC-2.1, AC-2.5)
- **WHEN** `check` runs on a clean fixture repo
- **THEN** it exits 0, prints ERC ✓ DRC ✓ drift ✓, makes no network calls to any api.* host, and finishes in < 60 s

#### Scenario: Broken schematic fails with location (AC-2.2)
- **WHEN** `check` runs on a schematic with an unconnected pin
- **THEN** it exits non-zero and prints the violation with its sheet and location

#### Scenario: --fab superset preserves base behavior
- **WHEN** `check --fab` runs on a repo that would fail plain `check`
- **THEN** the base ERC/DRC/drift violations are reported exactly as plain `check` reports them, before the fab-gate results

### Requirement: JSON output mode
With `--json`, commands SHALL emit machine-readable results with stable keys. When `--fab` is passed to `check`, the JSON output SHALL additionally contain the stable `fab` key defined by the fab-release-gate capability.

#### Scenario: check --json (AC-2.4)
- **WHEN** `copperhead check --json` runs
- **THEN** stdout is parseable JSON whose keys (erc, drc, drift, violations) are stable across runs

#### Scenario: check --fab --json adds the fab key
- **WHEN** `copperhead check --fab --json` runs
- **THEN** the JSON output contains the base keys unchanged plus a `fab` object

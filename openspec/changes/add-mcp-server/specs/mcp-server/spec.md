# mcp-server — Delta Spec

## ADDED Requirements

### Requirement: Stdio MCP server exposing opaque pipeline tools
`copperhead mcp` SHALL start a stdio MCP server exposing exactly five tools: `copperhead_check`, `copperhead_do`, `copperhead_sync`, `copperhead_init`, and `copperhead_doctor`. The server SHALL expose no file-edit, raw-KiCad, or partial-loop tools, and SHALL open no network transport. Commands outside this set (including `create`, `draft`, `score`, `export`, `demo`, and `repl`) SHALL NOT be exposed.

#### Scenario: Tool list is the whole surface
- **WHEN** an MCP host requests the tool list
- **THEN** exactly the five named tools are returned, each with a JSON schema for inputs and a description stating what the pipeline guarantees

#### Scenario: No bypass surface exists
- **WHEN** the server's registered tools are enumerated in tests
- **THEN** no tool can mutate a repo file except by running the full gated `do`/`sync` pipeline

#### Scenario: Adding a tool cannot silently widen the surface
- **WHEN** a tool is registered whose input schema accepts a filesystem path or which drives a single loop step
- **THEN** the surface-audit test fails, unless the path is the `copperhead_init` search path, which is permitted only because it is contained (below)

### Requirement: Results use the shared envelope and the pipeline stays out of the agent catalog
Every tool result SHALL be constructed through the shared `ToolResult` envelope so redaction happens at construction, and every error SHALL carry one of the shared `ToolErrorKind` values. The five pipeline tools SHALL NOT be registered in the agent capability catalog.

#### Scenario: Secrets cannot survive a result
- **WHEN** a tool result would otherwise carry an API key in its text
- **THEN** the returned result has the key replaced with a redaction marker

#### Scenario: The pipeline is unreachable from inside the loop
- **WHEN** the agent capability catalog is queried for the five pipeline tool names
- **THEN** none of them resolves, so no agent run can invoke a gated pipeline from within a gated pipeline

### Requirement: Experimental status and unstable protocol version
The server SHALL declare an unstable protocol version with a `0.` major, SHALL announce its experimental status on startup on stderr, and SHALL describe the surface as unstable in its server metadata. Tool sets, input schemas, and result shapes MAY change in any release while the version major is `0`.

#### Scenario: Startup announces instability
- **WHEN** `copperhead mcp` starts
- **THEN** an experimental notice naming the protocol version is written to stderr, and stdout carries only the JSON-RPC stream

#### Scenario: Instability is discoverable by the host
- **WHEN** an MCP host completes the initialization handshake
- **THEN** the server's reported version has a `0.` major and its metadata states that the surface is unstable

### Requirement: copperhead_check tool
`copperhead_check` SHALL run the LLM-free `check` pipeline on the configured repo and return the same structured report as `check --json`. The tool SHALL NOT advertise inputs the `check` pipeline does not accept; `fab` and `strict` inputs are out of scope until `check` itself accepts them.

#### Scenario: Check over MCP matches CLI
- **WHEN** `copperhead_check` runs on the fixture repo
- **THEN** the tool result equals the output of `copperhead check --json` on the same repo state

#### Scenario: Check makes no model or network call
- **WHEN** `copperhead_check` runs with no API key present and no network available
- **THEN** the check completes and returns its report

### Requirement: Host-supplied paths are contained to the repo root
`copperhead_init` is the only tool that accepts a filesystem path, and that path SHALL be resolved through the repo-root containment helper before use. A path that resolves outside the repo root SHALL be refused with a typed `validation` error, and no scaffolding SHALL be written.

#### Scenario: A relative path that escapes the repo is refused
- **WHEN** `copperhead_init` is called with a `path` of `../..`
- **THEN** the result is a `validation` error naming the escape, and the repo's configuration is unchanged

#### Scenario: An absolute path is refused
- **WHEN** `copperhead_init` is called with an absolute `path`
- **THEN** the result is a `validation` error and nothing is written

### Requirement: copperhead_do tool
`copperhead_do` SHALL accept a change-request string (and optional `dry_run` boolean), run the full gated loop non-interactively (AUTO marker), emit MCP progress notifications while the run proceeds, and return a run summary containing at minimum: status (`committed`, `rolled_back`, or `refused`), commit hash when committed, files touched, verification results, and the transcript path. Intermediate loop steps SHALL NOT be exposed as tool interactions.

#### Scenario: Successful run returns a committed summary
- **WHEN** `copperhead_do` completes a change that passes verification
- **THEN** the result has status `committed`, the commit hash, the files touched, and the transcript path

#### Scenario: Rollback is a result, not an error
- **WHEN** violations persist past `maxRepairCycles` during a `copperhead_do` run
- **THEN** the tool call succeeds at the protocol level and the result has status `rolled_back` with the transcript path, and the working tree is byte-identical to the pre-run state

### Requirement: copperhead_doctor tool
`copperhead_doctor` SHALL probe the environment copperhead depends on and return the same structured report as `doctor --json`. It SHALL make no model call and no network call, SHALL change nothing, and SHALL work with no credential present. It SHALL NOT require `kicad-cli` to be available, reporting a missing `kicad-cli` as a failed check rather than as a tool error.

#### Scenario: A host can diagnose itself without a credential
- **WHEN** `copperhead_doctor` is called with no API key in the environment
- **THEN** the report is returned with its checks, and no error is raised

#### Scenario: A missing kicad-cli is reported, not thrown
- **WHEN** `copperhead_doctor` runs where `kicad-cli` is not on PATH
- **THEN** the result is a report containing a failed `kicad-cli` check, not a tool error

#### Scenario: The report never carries a credential value
- **WHEN** the environment holds an API key and `copperhead_doctor` reports on it
- **THEN** the key value does not appear anywhere in the result

### Requirement: copperhead_sync tool
`copperhead_sync` SHALL run the deterministic verify phase and return the inconsistency report; it SHALL run the LLM resolve phase only when the boolean input `resolve` is true, with requirement violations flagged and never silently resolved, per the sync contract.

#### Scenario: Verify-only by default
- **WHEN** `copperhead_sync` is called without `resolve`
- **THEN** the result is the full inconsistency report and no repo file changes

### Requirement: Key handling and honest degradation
The server SHALL read API keys only from environment variables. `copperhead_check` and `copperhead_init` SHALL work with no key present; `copperhead_do` and `copperhead_sync` with `resolve: true` SHALL return a typed error naming the missing environment variable. Keys SHALL never be accepted as tool inputs nor appear in any tool result.

#### Scenario: Keyless host can still verify
- **WHEN** no API key env var is set and `copperhead_check` is called
- **THEN** the check runs and returns its report

#### Scenario: Keyless do degrades honestly
- **WHEN** no API key env var is set and `copperhead_do` is called
- **THEN** the result is a typed error naming the expected env vars, and no run is started

### Requirement: Mutating tools are serialized per repo
The server SHALL serialize `copperhead_do`, `copperhead_sync` (with `resolve`), and `copperhead_init` calls against the same repo, queueing or rejecting concurrent mutations with a typed busy error, while allowing concurrent `copperhead_check` calls.

#### Scenario: Concurrent do calls do not interleave
- **WHEN** a second `copperhead_do` arrives while one is running
- **THEN** it is queued or receives a typed busy error, and the repo never sees interleaved runs

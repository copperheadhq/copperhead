# run-protocol-handshake — Delta Spec

## ADDED Requirements

### Requirement: Versioned protocol identifier
The capability discovery record SHALL include the protocol identifier `copperhead-run/1` with supported major version `1`. Breaking changes to the handshake or stream contracts SHALL require a major version bump. Additive changes SHALL retain the major version.

#### Scenario: Handshake reports protocol major 1
- **WHEN** `copperhead capabilities --json` is executed
- **THEN** stdout is a JSON document whose `protocol` property equals `"copperhead-run/1"`

#### Scenario: Consumer rejects unsupported protocol major
- **WHEN** a consumer expecting protocol major 1 receives a document with `protocol` `"copperhead-run/2"`
- **THEN** the consumer refuses to proceed and aborts before starting work

#### Scenario: Consumer ignores unknown additive fields
- **WHEN** a consumer processes a capability document containing additional unknown properties
- **THEN** the consumer accepts the document without validation errors

### Requirement: Honest feature advertisement
The capability document SHALL include a `features` array enumerating only capabilities fully implemented and verified in the current build. In Phase 0, this list SHALL be empty. Unimplemented capabilities SHALL NOT be advertised.

#### Scenario: Phase 0 advertises an empty feature array
- **WHEN** `copperhead capabilities --json` runs
- **THEN** the `features` array is empty (`[]`)

#### Scenario: Unimplemented stream capabilities are omitted
- **WHEN** the capability document is inspected
- **THEN** `features` does not contain `"event-stream"`, `"result-document"`, or `"run-id"`

### Requirement: Deterministic top-level command inventory
The capability discovery record SHALL include a `commands` array containing the lexicographically sorted list of registered top-level primary commands. In Phase 0, command aliases and nested subcommands SHALL NOT be listed in the top-level array.

#### Scenario: Handshake lists registered primary commands
- **WHEN** `copperhead capabilities --json` runs
- **THEN** `commands` contains the sorted list of primary command names matching the registered CLI commands

### Requirement: Tool dependency probing and safe degradation
The capability document SHALL report installed tool versions under `tools` for `kicadCli`, `git`, `openspec`, and `node`. A missing, malformed, failing, or timed-out tool probe SHALL report `null` for that tool and SHALL NOT fail the handshake. Probe failures SHALL NOT leak internal filepaths or stack traces.

#### Scenario: All tools present
- **WHEN** all tool binaries are installed and accessible
- **THEN** `kicadCli`, `git`, `openspec`, and `node` contain their respective version strings

#### Scenario: Missing KiCad CLI degrades to null
- **WHEN** `kicad-cli` is not installed or not found on PATH
- **THEN** `tools.kicadCli` is `null` and the handshake exits 0 with valid JSON

#### Scenario: Timed-out tool probe degrades to null
- **WHEN** a tool probe subprocess exceeds its execution deadline (5000 ms)
- **THEN** the subprocess is terminated, that tool reports `null`, and the handshake exits 0

#### Scenario: Malformed or warning-only tool output degrades to null without path leakage
- **WHEN** a tool probe emits unparseable diagnostics or host warning paths
- **THEN** that tool reports `null` and no host paths appear in stdout

#### Scenario: Missing Git degrades to null
- **WHEN** `git` is not installed or not found on PATH
- **THEN** `tools.git` is `null` and the handshake exits 0 with valid JSON

#### Scenario: Missing OpenSpec degrades to null
- **WHEN** `openspec` is not installed or not found on PATH
- **THEN** `tools.openspec` is `null` and the handshake exits 0 with valid JSON

### Requirement: Offline and repository-independent discovery
The `capabilities` command SHALL require no git repository, no KiCad project, no model API credentials, and no network requests. It SHALL NOT alter the filesystem or create workspace artifacts.

#### Scenario: Invocation in an empty directory
- **WHEN** `copperhead capabilities --json` runs in an empty non-git directory
- **THEN** the command exits 0, prints valid JSON, and creates no files or directories

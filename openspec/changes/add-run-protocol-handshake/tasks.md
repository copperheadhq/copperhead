# Tasks: add-run-protocol-handshake

## 1. Protocol Foundation and Capability Engine

- [x] 1.1 Define protocol constant `COPPERHEAD_RUN_PROTOCOL = 'copperhead-run/1'` and `SUPPORTED_PROTOCOL_MAJOR = 1`
- [x] 1.2 Define `IMPLEMENTED_PROTOCOL_FEATURES` as an empty array for Phase 0
- [x] 1.3 Implement `CapabilityReport`, `ToolVersions`, and `CapabilityDeps` interfaces
- [x] 1.4 Implement `isProtocolCompatible` and `assertProtocolCompatible` consumer validation helpers

## 2. Tool Probing and Error Isolation

- [x] 2.1 Implement safe `node` version extraction via `process.version`
- [x] 2.2 Implement safe `kicadCli` probe via `kicadCliVersion()` with null degradation on missing binary or parse failure
- [x] 2.3 Implement safe `git` probe via `git --version` with timeout and null degradation
- [x] 2.4 Implement safe `openspec` probe via `openspec --version` with timeout and null degradation
- [x] 2.5 Ensure subprocess probe errors catch internally without leaking host filepaths or stack traces into the JSON record
- [x] 2.6 Implement dynamic extraction of public commands from Commander registrations with deterministic lexicographical sorting

## 3. CLI Command Registration

- [x] 3.1 Register `copperhead capabilities` command on Commander program in `src/cli.ts`
- [x] 3.2 Wire global `--json` option to emit clean, formatted JSON
- [x] 3.3 Implement `formatCapabilities` for human-readable terminal output when `--json` is omitted
- [x] 3.4 Ensure command requires no git repository, no KiCad project, no model credentials, and zero network calls

## 4. Verification and Parity Tests

- [x] 4.1 Unit tests with dependency injection for normal tool reporting
- [x] 4.2 Unit tests for missing tool degradation (`kicadCli: null`, `git: null`, `openspec: null`)
- [x] 4.3 Unit tests for protocol compatibility acceptance and rejection of unknown majors
- [x] 4.4 Unit tests for consumer extensibility ignoring unknown JSON fields
- [x] 4.5 Subprocess integration tests exercising `node dist/cli.js capabilities --json` in temporary directories
- [x] 4.6 Subprocess integration tests verifying clean stderr and absence of created files
- [x] 4.7 Parity test confirming build (`dist/cli.js`) and source (`src/cli.ts`) emit identical capability records
- [x] 4.8 Parity test confirming `commands` array matches registered CLI command set

## 5. Specification and Documentation

- [x] 5.1 Create OpenSpec change `add-run-protocol-handshake` with proposal, design, tasks, and delta specs
- [x] 5.2 Validate OpenSpec change using `openspec validate add-run-protocol-handshake`
- [x] 5.3 Document AC-17 acceptance criteria in `openspec/specs/SPEC.md`

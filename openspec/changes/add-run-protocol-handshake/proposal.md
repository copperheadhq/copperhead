# add-run-protocol-handshake: Proposal

## Why

External non-interactive consumers (hosted runners, CI automations, external supervisors, and MCP hosts) currently have no stable, machine-readable mechanism to query Copperhead for supported protocol versions, registered commands, active features, and installed tool dependencies before starting an agent run. Today, consumers resort to heuristic parsing of human-oriented CLI help text or pinning arbitrary CLI version numbers without capability validation.

Issue #258 outlines the need for a versioned run protocol stream. Phase 0 establishes the foundation: an offline, deterministic capability discovery handshake (`copperhead capabilities --json`) anchored by an explicit protocol identifier (`copperhead-run/1`).

## What Changes

- **New CLI command: `copperhead capabilities [--json]`**:
  - Emits a well-formed machine-readable JSON capability descriptor when `--json` is specified:
    ```json
    {
      "protocol": "copperhead-run/1",
      "cli": "0.12.0",
      "commands": ["capabilities", "check", "create", "demo", "do", "doctor", "draft", "export", "init", "mcp", "repl", "review", "score", "skill", "sync"],
      "features": [],
      "tools": {
        "kicadCli": "9.0.1",
        "git": "2.43.0",
        "openspec": "1.14.1",
        "node": "v20.19.0"
      }
    }
    ```
  - Without `--json`, prints a human-readable capability summary on stdout.
- **Protocol versioning and compatibility contract**:
  - Declares the wire protocol constant `copperhead-run/1` with supported major version `1`.
  - Breaking changes to the machine interface require a major version bump (`copperhead-run/2`).
  - Additive changes retain the major version.
  - Consumers validate the protocol major before starting work and reject unknown major versions.
  - Consumers ignore unknown JSON fields for forward compatibility.
- **Dynamic command inventory**:
  - Derives the public command list dynamically from Commander registrations and sorts them lexicographically for deterministic output across runs.
- **Honest feature advertisement**:
  - `features` advertises only capabilities fully implemented in the current build.
  - In Phase 0, `features` is an empty array (`[]`), reflecting that Phase 1-4 stream features are not yet implemented.
- **Isolated tool dependency probing**:
  - Tool versions for `kicadCli`, `git`, `openspec`, and `node` are probed with safe subprocess calls bounded by execution timeouts.
  - Probe failures degrade cleanly to `null` without throwing or failing the handshake.
  - No host filepaths or internal error traces leak into the JSON output.
- **Strict execution boundaries**:
  - Fully offline, network-free, credential-free, and repository-independent.
  - Runs in non-git directories, empty directories, and CI runners lacking KiCad.

## Capabilities

### New Capabilities
- `run-protocol-handshake`: The `copperhead capabilities` command, the `copperhead-run/1` protocol constant, tool version reporting with null degradation, empty feature array in Phase 0, and reference consumer compatibility validation.

### Modified Capabilities
- `cli-surface`: The CLI registers the `capabilities` command and honors the global `--json` option.

## Non-Goals

Phase 0 is strictly scoped to capability discovery. It explicitly excludes:
- NDJSON event streams (`--event-stream`)
- Result document generation (`--result`)
- Run identity parameters (`--run-id`, `COPPERHEAD_RUN_ID`)
- Hosted run job leases and orchestration policies
- Signal-based cancellation semantics
- Artifact persistence and upload
- Token cost accounting and transport
- Provider SDK modifications or model routing changes
- PCB or schematic mutation behavior

## Impact

- **Code**: Adds `src/commands/capabilities.ts` and registers the command in `src/cli.ts`.
- **Dependencies**: Zero new runtime dependencies. Built-in Node and existing `execa` are used.
- **Breaking Changes**: None. The command is purely additive.

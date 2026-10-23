# add-run-protocol-handshake: Design

## Context

The Copperhead CLI is increasingly invoked by non-interactive callers: CI workflows, local developer tooling, and hosted runners. Before issuing an agent run (such as `do` or `create`), a caller must know:
1. Whether the installed CLI binary speaks a supported wire protocol major.
2. What public commands are registered and callable.
3. What features are actually implemented in this build.
4. What tool versions (Node, KiCad CLI, Git, OpenSpec) are present on the host.

Today, consumers lack a machine-readable handshake. Probing `doctor --json` is inappropriate because `doctor` is an environmental health check that inspects provider API credentials, repository configuration, and project scaffolding. Coupling protocol negotiation to `doctor` would force callers to provide API keys or repository files merely to discover what the CLI binary supports.

Issue #258 outlines the multi-phase run protocol roadmap. Phase 0 delivers the capability discovery handshake.

## Goals / Non-Goals

**Goals:**
- Provide a fast, offline, deterministic capability discovery handshake via `copperhead capabilities --json`.
- Anchor the contract with an explicit protocol identifier `copperhead-run/1`.
- Ensure tool probe failures degrade softly to `null`, never failing discovery.
- Keep the feature list honest: advertise only capabilities implemented today (`features: []`).
- Derive command lists dynamically from Commander registrations to prevent catalog drift.
- Ensure zero repository dependencies: the command works anywhere, including clean CI runners without KiCad.

**Non-Goals:**
- No event streaming (`--event-stream`) in this phase (belongs to Phase 1).
- No result documents (`--result`) in this phase (belongs to Phase 2).
- No hosted leases, exit status taxonomies, or signal-based cancellation (delegated to #251).
- No artifact storage or upload (delegated to #250).
- No model routing or token usage split (delegated to #249).

## Decisions

- **D1: Capabilities discovery is separate from doctor.**
  `doctor` checks environment readiness (e.g. model provider keys and git config in the current repository). `capabilities` discovers binary capabilities and installed tool versions. They have different lifecycles and boundaries. `capabilities` does not import or wrap `DoctorReport`.

- **D2: Versioning follows explicit major semantics (`copperhead-run/1`).**
  The protocol identifier contains a major version number. A consumer pins major `1` and refuses unknown majors. Within a major, additive enhancements (new tool fields, new features) are permitted and must be tolerated by consumers.

- **D3: Feature advertisement represents shipped reality.**
  A feature string is added to `features` only when its flags, transport, and runtime semantics are implemented and tested. In Phase 0, no protocol stream features are active, so `features` is an empty array (`[]`). This prevents consumers from assuming event streams or result documents are ready when they are not.

- **D4: Command inventory is derived dynamically and sorted deterministically.**
  Public commands are extracted directly from the registered Commander program rather than relying on a static catalog that can silently drift. For Phase 0, the handshake advertises top-level primary command names only; aliases (such as `verify` for `check`) and nested subcommands (e.g. `skill list`, `export bom`) are dispatched under their primary entry points. The resulting array is sorted lexicographically for reproducible output.

- **D5: Isolated subprocess probes with timeout bounds and anchored version parsing.**
  Subprocess probes for `kicad-cli`, `git`, and `openspec` use explicit argument lists without shell interpolation and are bounded by a 5000 ms deadline (including `kicad-cli` via `kicadCliVersion({ timeout: 5000 })`). When a tool is not installed, times out, or errors, its entry in `tools` is `null`. Probe outputs are strictly validated against anchored version patterns; warning-only output, diagnostic text, stack traces, and local filesystem paths are rejected and never leaked into the JSON output.

- **D6: Dependency injection for test isolation.**
  `collectCapabilities` accepts injectable `CapabilityDeps`, allowing automated unit tests to verify missing-tool scenarios deterministically on any operating system without modifying system PATH.

## Risks / Trade-offs

- **[Tool probes could hang indefinitely]** -> Resolved by enforcing a 5-second deadline on all subprocess calls (`kicad-cli`, `git`, `openspec`), terminating timed-out subprocesses and degrading safely to null.
- **[Command inventory drift]** -> Resolved by dynamic extraction from Commander registrations and automated parity tests against observed CLI registration.
- **[Over-promising future capabilities]** -> Resolved by maintaining an empty feature list in Phase 0 until subsequent phases land.

## Migration Plan

The command is purely additive. Existing commands, options, and behaviors remain identical.
Future phases of Issue #258 will add entries to `features` (e.g. `event-stream`, `result-document`) without breaking existing consumers.

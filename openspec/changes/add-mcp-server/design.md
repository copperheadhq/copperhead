# add-mcp-server: Design

## Context

The MCP ecosystem's existing KiCad servers expose fine-grained operations (edit this footprint, run DRC) and leave the loop to the host agent, which is precisely the architecture copperhead exists to reject: the host loop has no spec gate, no verification obligation, no rollback. The wrapper's entire value is that it exposes outcomes, not operations. The command layer already produces structured results (`runCheck`, `syncVerify` / `syncResolve`, `runInit`, `runAgentLoop`), so the server is a transport, not a reimplementation.

The complication is timing. The tool-frame half of the substrate has landed — a registry, per-tool schema versions, and a redacting result envelope — and this change consumes it (D9). The run-protocol half has not: there is still no way for a consumer to ask the CLI what it supports, and no versioned result document. Shipping a stable MCP contract before that exists would create a second machine surface the protocol work then has to reconcile. Shipping an explicitly unstable one does not, because an unstable surface makes no promise to reconcile against.

## Goals / Non-Goals

**Goals:**

- Any MCP host can run the full gated pipeline with five tools and zero copperhead knowledge.
- Impossible-by-construction bypass: no tool the server exposes can mutate repo files outside the gated loop.
- Results are self-describing enough for a host agent to relay honestly (verification state, rollback occurrence, transcript path).
- The surface stays cheap to change until the protocol and registry work settles.

**Non-Goals:**

- No stability promise, no semantic-versioning guarantee, and no registry listing in this change (see D7).
- No HTTP/SSE transport (stdio covers Claude Code, Codex, Cursor, and desktop hosts; remote transport belongs with a hosted story).
- No streaming of intermediate agent turns over MCP (the run summary is the contract; the transcript file has the detail).
- No `fab` / `strict` inputs on `copperhead_check`: `check` accepts no options today, and the tool surface must not advertise a capability the pipeline cannot honor. They arrive when `check` learns them.
- **No exposure of the rest of the CLI.** `draft`, `schematic`, `score`, `demo`, `create`, `export`, and `repl` are deliberately absent. Every tool added is another place the gating invariant has to be proven absent-by-construction, and `create`-style multi-stage runs can exceed host tool timeouts and need a job-style pattern that does not exist. Five tools is the surface the opacity argument can carry today, and the fifth earns its place by being read-only (D10).
- No MCP resources/prompts surface beyond the tools.

## Decisions

- **D1: Opaque outcome tools, not operation tools.** Tool granularity is the security boundary: exposing only whole-pipeline invocations means spec-gating and verification-gating cannot be skipped by any sequence of tool calls. Alternative: expose the internal tool families over MCP — rejected; that reproduces the competitor architecture and forfeits both invariants.
- **D2: `mcp` as a CLI subcommand on stdio.** Hosts configure `copperhead mcp` as a stdio server; no daemon, no port, no separate binary to version. The official TypeScript SDK handles the protocol.
- **D3: Server calls the command layer, not the CLI.** The server dispatches into the exported entry points that already return the structured objects `--json` prints, and maps their failures onto typed MCP errors. Shelling out to our own CLI would double process management and lose typed errors. The entry points exist today, so the code motion here is the server and its error mapping, not a refactor of `src/commands/`.
- **D4: Non-interactive by default, and honest about keys.** `copperhead_do` runs with the AUTO marker (no y/n gate to answer over MCP). At startup the server detects available API keys; `copperhead_check` and `copperhead_init` always work, and `copperhead_do`/`copperhead_sync` (resolve) return a typed error naming the missing env var when no key exists. Alternative: accept keys as tool inputs — rejected; keys stay in env vars per the safety rails, never in tool-call payloads that hosts may log.
- **D5: Long-run handling via progress notifications.** A `do` run can take minutes; the server emits MCP progress notifications while the loop runs so hosts do not time out, and the tool result is returned when the run commits or rolls back. No detach/poll pattern in this change (that is what keeps `create` out of scope).
- **D6: Errors are results, not protocol errors.** A rollback after `maxRepairCycles` is a successful tool call whose result says `status: "rolled_back"` with the transcript path; protocol-level errors are reserved for misuse (bad input, missing repo, missing key). Host agents relay results far better than they relay exceptions.
- **D7: Ship experimental, with an unstable protocol version.** The server declares its own `copperhead-mcp/0.x` version, prints its experimental status to stderr on startup, and is documented as unstable; no registry submission until the stabilization criteria in the proposal are met. Rationale: the value of the server is the threat model it closes, which is real today, but a stable tool schema is a contract with hosts we do not control and cannot migrate — on a CLI that shipped four minor versions in six weeks. Declaring instability buys the distribution and the field feedback without the contract. Alternative: block the whole change on the run-protocol handshake — rejected; the handshake is the right home for a *stable* surface, and gating on it trades a real, closable threat for a scheduling dependency.
- **D8: The run-protocol handshake is the stabilization trigger, not a prerequisite.** When `copperhead capabilities --json` and the `copperhead-run/<major>` constant land, the server reports its surface through them and drops the local version constant; that migration, plus a quiet minor, is what takes the experimental marker off. Until then the local version is deliberately shaped like a placeholder so it is awkward to depend on.
- **D9: Adopt the shared result envelope; deliberately do not join the tool catalog.** The tool registry, per-tool `version`, and the `ToolResult` envelope (`{ ok, summary, detail?, data?, error?, viewHint? }` with `ToolErrorKind` and `seal()`-time redaction) already exist in `src/agent/envelope.ts` and `src/agent/registry.ts`. The server builds its results with `seal()` and reports errors with the shared `ToolErrorKind` values, so redaction and error semantics are inherited rather than reimplemented — this is how "keys never appear in a result" is guaranteed instead of asserted.

  The five pipeline tools are nevertheless **not** registered in the capability catalog, and that is a requirement rather than an omission. A `CatalogEntry` is gated on `RunContext` — an in-flight run — and is therefore callable by the agent loop. Registering `copperhead_do` there would make the whole gated pipeline reachable from inside the pipeline, which is both a recursion hazard and a hole straight through D1: the agent could invoke a fresh gated run instead of passing its own spec gate. The catalog is the agent's tool frame; MCP is the host's. They share the envelope and stay separate surfaces, and a test asserts the pipeline tool names resolve to nothing in the registry.

- **D10: `doctor` is the fifth tool, and the only one admitted on diagnostic grounds.** It is LLM-free, network-free, and mutates nothing, so it widens the surface without widening what the surface can *do* — the opacity argument in D1 is about mutation paths, and a read-only probe adds none. It earns its place because "is this host configured correctly" is the largest predictable support cost of shipping an MCP server, and without it a host meets a missing `kicad-cli` as an opaque `unavailable` error on some other tool. Unlike every other tool it deliberately skips the `kicad-cli` preflight: gating a diagnostic on the thing it diagnoses would fail exactly when it is needed. Alternative: leave hosts to run `copperhead doctor` in a terminal — rejected; the host agent is the one hitting the error, and it cannot see a terminal.

## Risks / Trade-offs

- [Host agent edits `.kicad_sch` with its own file tools anyway] → out of copperhead's control by definition; the companion skill instructs against it, and the pre-commit hook plus `check` in CI still catch the damage. The wrapper narrows the sanctioned path; it cannot confiscate the host's own tools.
- [Experimental status is ignored and hosts pin the surface anyway] → the startup notice and README say unstable, and the version constant carries a `0.` major; if breakage lands on real users anyway, that is evidence to stabilize sooner, not to have promised earlier.
- [A second entry point weakens the gating invariant] → the invariant is enforced today at one place in the agent tool layer. The MCP surface inherits it only while dispatch stays opaque, so the surface-audit test is a required part of this change, not a follow-up: the first tool that takes a file path or drives a partial loop silently ends the guarantee.
- [Tool timeout on slow `do` runs despite progress notifications] → summary includes the transcript path; a timed-out host can re-check repo state with `copperhead_check`, and the run itself completes or rolls back regardless (the subprocess is not killed by host timeout).
- [SDK/protocol churn] → thin surface (five tools, stdio); protocol version pinned in tests with golden request/response fixtures.
- [Concurrent tool calls racing one repo] → the server serializes mutating tools per repo with the existing dirty-tree guard as backstop; concurrent `check` calls are safe and unrestricted.
- [Ongoing support burden on a project already behind on review] → the surface is five tools and one transport, and the experimental marker sets the expectation that host-specific breakage is not an emergency. If the burden proves real, the fallback is the skill alone, which needs no server.

## Migration Plan

Additive command. Nothing to migrate; if the SDK breaks, the CLI is unaffected. The forward migrations are the ones in D8 and D9 — reporting through the run-protocol handshake, and rebuilding the tool definitions from the tool registry — both of which are cheap by construction while the surface is unstable.

## Open Questions

- Whether the companion skill should also ship in whatever format Codex settles on. Claude Code's skill format is stable and shipped here; the Codex gap is documented in `integrations/README` with the guidance duplicated into `AGENTS.md` as the interim answer.

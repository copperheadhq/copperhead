# Tasks: add-mcp-server

## 1. Command-layer entry points

The entry points already exist and return structured results (`runCheck`, `syncVerify` / `syncResolve`, `runInit`, `runAgentLoop`); this section confirms they are usable from a non-CLI caller rather than refactoring them.

- [x] 1.1 Audit the four entry points for CLI-only coupling (direct `console` writes, `process.exit`, interactive prompts) and thread the existing injection points (log callbacks, AUTO marker) so a non-CLI caller gets the same structured result
- [x] 1.2 Golden test: the structured result each entry point returns is byte-identical to what the corresponding `--json` CLI path prints, so the server and the CLI cannot drift

## 2. Server

- [x] 2.1 Add `@modelcontextprotocol/sdk`; implement `src/mcp/server.ts` with stdio transport and the five tool registrations with versioned JSON schemas
- [x] 2.1a Build every tool result through the shared `ToolResult` envelope and `seal()` so redaction is inherited, not reimplemented; map failures onto the shared `ToolErrorKind` values
- [x] 2.2a Implement `copperhead_doctor`: no `kicad-cli` preflight (it reports a missing one as a failed check), keyless, read-only (design D10)
- [x] 2.2 Implement `copperhead_check` (no inputs; `fab`/`strict` deliberately absent until `check` accepts them) and `copperhead_init` dispatch
- [x] 2.3 Implement `copperhead_do`: AUTO marker, optional `dry_run`, progress notifications during the run, summary result (`committed`/`rolled_back`/`refused`, commit hash, files touched, verification, transcript path)
- [x] 2.4 Implement `copperhead_sync` with `resolve` gating
- [x] 2.5 Implement key detection using the shared `ToolErrorKind` values: `unavailable` when no key resolves (naming the env vars) and when two credentials make the choice ambiguous; keyless operation for check/init
- [x] 2.6 Implement per-repo serialization of mutating tools with typed busy error; concurrent check allowed
- [x] 2.7 Declare the unstable `copperhead-mcp/0.x` protocol version, announce experimental status on stderr at startup, and state instability in the server metadata
- [x] 2.8 Wire `copperhead mcp [--repo]` into the CLI with the experimental marker in its description and the bad-path error
- [x] 2.9 Assert stdout discipline: no code path on the server reaches `console.log`; all human output goes to stderr

## 3. Tests

- [x] 3.1 Protocol tests over stdio with golden request/response fixtures (tool list, each tool, progress notifications), pinned protocol version
- [x] 3.2 Parity test: `copperhead_check` result equals `check --json` on the same repo state
- [x] 3.3 Rollback-as-result test; keyless degradation tests; serialization/busy test
- [x] 3.4 Surface audit test (required, not follow-up): enumerate registered tools and assert none accepts a filesystem path, drives a single loop step, or mutates files outside the gated pipeline
- [x] 3.4a Assert the five pipeline tool names resolve to nothing in the agent capability catalog, so the pipeline can never be invoked from inside the loop it runs (design D9)
- [x] 3.4b Assert a result carrying a fake API key in its text comes back redacted, proving the envelope path is actually used
- [x] 3.5 Assert the declared protocol version has a `0.` major and the startup notice names it, so dropping the experimental marker is a deliberate edit with a failing test behind it

## 4. Integrations and documentation

- [x] 4.1 Write the companion Claude Code skill under `integrations/claude-code/` (use copperhead tools, never edit `.kicad_*` directly); Codex equivalent or a documented gap note
- [x] 4.2 README: MCP section with host configuration snippets (Claude Code, generic stdio host), stating the surface is experimental and unstable
- [x] 4.3 Document the stabilization criteria (run-protocol handshake adopted, tool definitions built from the tool registry, one quiet minor) in `integrations/README` as the gate for registry submission

## 5. Deferred until stabilization

Not part of this change; listed so the gate is explicit.

- [ ] 5.1 Report the surface through `copperhead capabilities --json` and the `copperhead-run/<major>` constant; drop the local version constant
- [ ] 5.2 Submit registry listings (modelcontextprotocol servers repo, community registries); track links in `integrations/README`

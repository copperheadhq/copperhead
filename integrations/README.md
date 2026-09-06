# Integrations

Host-side configuration for the `copperhead mcp` server, and the companion skill
that tells a host agent to use it.

> **Experimental.** The MCP surface declares a `0.` protocol major. Tool names,
> input schemas, and result shapes may change in any release. Pin a copperhead
> version if you depend on the shapes, and read the stabilization criteria below
> before building anything durable on it.

## What the server exposes

Exactly five tools, and nothing finer:

| Tool | LLM | Mutates | Purpose |
| --- | --- | --- | --- |
| `copperhead_check` | no | no | ERC, DRC, doc drift, spec validation |
| `copperhead_init` | no | yes | scaffold docs memory from an existing schematic |
| `copperhead_do` | yes | yes | the full gated change pipeline |
| `copperhead_sync` | only with `resolve: true` | only with `resolve: true` | design-state consistency, and optionally fix drift |
| `copperhead_doctor` | no | no | probe node, kicad-cli, git, openspec and the model credential |

There is deliberately no file-edit tool, no raw KiCad tool, and no way to drive a
single step of the loop. That is the point: a host agent integrating copperhead
cannot bypass spec-gating or verification-gating by any sequence of calls.

`copperhead_check`, `copperhead_init` and `copperhead_doctor` need no credential. `copperhead_doctor`
is also the one tool that does not require `kicad-cli` to be present — it reports a missing one as a
failed check, so a host can diagnose its own setup rather than meeting an opaque error elsewhere. `copperhead_do` and
`copperhead_sync --resolve` return a typed `unavailable` error naming the missing
variable when no model can be resolved.

## Claude Code

```jsonc
// .mcp.json in the project, or the equivalent under `claude mcp add`
{
  "mcpServers": {
    "copperhead": {
      "command": "copperhead",
      "args": ["mcp", "--repo", "/absolute/path/to/your/kicad/project"]
    }
  }
}
```

Then install the companion skill so the agent prefers these tools over its own
file tools:

```bash
cp -r integrations/claude-code/copperhead ~/.claude/skills/
```

## Any stdio MCP host

The server speaks MCP over stdio and takes no network transport:

```bash
copperhead mcp --repo /absolute/path/to/your/kicad/project
```

stdout carries JSON-RPC alone; every human-readable line goes to stderr. A host
that merges the two streams will corrupt the protocol.

## Codex

Codex reads [`AGENTS.md`](../AGENTS.md) rather than Claude Code's skill format, so
there is no drop-in equivalent of the skill above. Until that gap closes, paste the
guidance from [the skill](claude-code/copperhead/SKILL.md) into the project's
`AGENTS.md` — the tool surface itself is host-agnostic and works from any stdio MCP
host.

## Stabilization criteria

The experimental marker comes off, and registry listings are submitted, when all of:

1. The run-protocol handshake (`copperhead capabilities --json` and a
   `copperhead-run/<major>` constant) exists, and the server reports its surface
   through it rather than through its own version constant.
2. The five tool input schemas carry an explicit version and have stopped changing
   shape. (The shared result envelope and its typed error kinds are already in
   place: results are built with the same `seal()` path the agent's own tools use,
   so redaction is inherited rather than reimplemented.)
3. The tool set has gone one minor release without an input-schema or result-shape
   change.

Until then there is no registry listing, and `copperhead mcp` announces its status
on startup. Tracking issue: [#40](https://github.com/copperheadhq/copperhead/issues/40).

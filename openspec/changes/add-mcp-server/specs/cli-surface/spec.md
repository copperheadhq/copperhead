# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `mcp` command
The CLI SHALL provide `copperhead mcp [--repo <path>]`, which starts the stdio MCP server defined by the mcp-server capability and runs until the host closes the transport. The command's description SHALL mark it experimental. The command SHALL exit non-zero with a clear message (no stack trace) when the target repo does not exist.

#### Scenario: Server starts on stdio
- **WHEN** `copperhead mcp` is spawned by an MCP host
- **THEN** the process serves the MCP protocol over stdio and lists the five pipeline tools

#### Scenario: Help marks the command experimental
- **WHEN** `copperhead --help` is run
- **THEN** the `mcp` entry is present and its description marks it experimental

#### Scenario: Bad repo path fails clearly
- **WHEN** `copperhead mcp --repo /nonexistent` is run
- **THEN** the process exits non-zero with a message naming the path, without a stack trace

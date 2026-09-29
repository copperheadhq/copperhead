# Electrical review over MCP

## ADDED Requirements

### Requirement: Read-only electrical review outcome

The MCP server SHALL add copperhead_diff to its opaque outcome tools, accepting optional base with HEAD~1 as default. It SHALL return the diff command's JSON report in the shared redacted envelope and advertise read-only behavior. It SHALL need no credential, KiCad executable, or network access and SHALL expose no raw filesystem input.

#### Scenario: Command parity

- **WHEN** copperhead_diff and the command compare the same repository and base
- **THEN** their report data is identical

#### Scenario: Invalid revision

- **WHEN** the requested base does not resolve
- **THEN** the result is a typed validation failure naming the invalid base

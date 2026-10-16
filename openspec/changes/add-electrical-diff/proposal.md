# Electrical change review

## Why

Issue #304 asks for a readable electrical review of KiCad changes. PR #305 initially copied only the root baseline sheet, failed on hierarchy, and lacked named-net, MCP, and dry-run integration.

## What Changes

- Add `diff --base <revision>` and JSON output with component, pin-to-net, and named-net changes.
- Materialize all referenced baseline and working sheets in isolated temporary trees, preserving paths and rejecting repository escapes.
- Normalize Windows separators, sort results, and explain invalid revisions or missing sheets. Missing baseline roots represent an empty design.
- Expose `copperhead_diff` through MCP and include the electrical preview in verified dry runs before rollback.
- Extend fixture, CLI, MCP, and loop tests and record manual edit-sandbox evidence.

## Capabilities

### New Capabilities

- `electrical-diff`: deterministic revision comparison, recursive extraction, net rename inference, and error contracts.

### Modified Capabilities

- `mcp-server`: add one read-only outcome tool to the existing opaque surface.
- `agent-core`: augment the verified dry-run output while retaining spec, verification, and rollback gates.

## Impact

Changes the diff command, read-only sheet path handling, MCP registration, and the dry-run result. No new dependencies, provider behavior, or network calls. SPEC acceptance criteria AC-17.1 through AC-17.7 and AC-3.9 describe the contract.

## Summary

Adds a deterministic, read-only electrical schematic review command:

```text
copperhead diff --base <rev> --json
```

It compares the configured working schematic with a local Git revision and reports component, pin-to-net, and named-net changes. The JSON result includes the requested base and resolved commit.

## Review fixes included

- Recursively materializes hierarchical and multi-sheet schematics for both baseline and working trees.
- Normalizes Windows backslashes for configuration, child-sheet references, and Git paths.
- Sorts components, changed references, connections, and nets deterministically.
- Reports actionable errors for invalid revisions, missing baseline files, unsafe paths, and missing child sheets.
- Adds named-net added, removed, and uniquely inferred renamed results.
- Registers `copperhead_diff` as a read-only MCP tool with the same data as CLI JSON.
- Adds the electrical preview to `do --dry-run` after the existing proposal/spec and verification gates, before rollback.
- Updates the open-key fixture for KiCad 10's `lib_symbol_mismatch` ERC severity key.

The diff remains read-only and offline: it does not invoke a model or KiCad, modify the project or Git index, or create a run transcript. Temporary sheet copies are cleaned up.

## Validation

Passing focused suites:

- `npx vitest run test/electrical-diff.test.ts test/cli-diff.test.ts test/electrical-diff-dry-run.test.ts`: 3 files, 14 tests passed.
- `npx vitest run test/mcp-server.test.ts -t "copperhead_diff"`: 2 MCP tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npx vitest run test/electrical-diff-dry-run.test.ts --testTimeout=180000`: passed.

Manual hierarchical CLI verification also passed with exit code 0. A temporary two-level fixture was edited and its child sheet renamed, then this command was run:

```text
node --import tsx src/cli.ts --repo <temporary-repo> diff --base HEAD --json
```

It reported the expected rename `KEY_DAH` to `KEY_DASH`.

The full `npm test` run still reports 18 failures in 7 unrelated test files. These are existing/environment-sensitive failures outside the electrical-diff paths: Windows line-ending expectations, Windows home-path formatting, and timeouts in unrelated gating, REPL, check, and registry tests. The electrical-diff, CLI, dry-run, and MCP feature tests pass independently; these full-suite failures are not caused by the feature changes.

# add-electrical-diff-command: Proposal

## Why

Raw git diffs on `.kicad_sch` s-expression files mix formatting, UUIDs, and xy coordinate shifts with actual electrical changes. Engineers reviewing a commit or a `copperhead do` / `copperhead create` run need a deterministic, LLM-free summary of what changed electrically: components added, modified, or removed; pin connection rewirings on surviving components; renamed, added, removed, or merged nets; and constraints from `.copperhead/constraints.json` affected by those changes.

## What Changes

- **`copperhead diff [--base <rev>]`**: a deterministic, LLM-free CLI command that compares the working-tree schematic against a git revision (defaulting to `HEAD` when the schematic has uncommitted edits, or `HEAD~1` after a committed run, falling back to `HEAD` on an initial single-commit repo).
- **Normalized electrical comparison (`diffSnapshots`)**: ignores xy position/rotation/UUID churn; reports component additions (with connected nets), value/footprint/libId modifications, and removals; reports pin connection changes on surviving components; detects net renames (across surviving pins), net merges (when two multi-pin nets collapse onto one), and net additions/removals; and cross-references `.copperhead/constraints.json`.
- **Sandboxed historical snapshot**: validates git revisions with `--end-of-options`, rejects option-like revisions starting with `-`, materializes hierarchical sub-sheets plus `sym-lib-table` / `.kicad_sym` files inside a sandboxed temp directory via `resolveInRepo` (`AC-4.2`), and supports `--json` output matching `runDiff` byte-for-byte.

## Capabilities

### New Capabilities

- `electrical-diff`: normalized schematic diffing across git revisions, covering components, surviving-component pin connections, net renames/merges, and affected constraints.

### Modified Capabilities

- `cli-surface`: adds `copperhead diff [--base <rev>]` with human-readable and `--json` output modes.

## Impact

- **Code**: `src/commands/diff.ts`, `src/cli.ts`.
- **Docs**: `README.md`, `docs/src/content/docs/reference/cli.md`.
- **Tests**: `test/diff.test.ts`, `test/entry-point-parity.test.ts`.

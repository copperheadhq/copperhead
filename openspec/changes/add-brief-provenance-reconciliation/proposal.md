# add-brief-provenance-reconciliation: Proposal

## Why

`copperhead create` writes `docs/BRIEF.sha256` after `spec-seed` to record the originating brief path and SHA-256, and subsequent `create` runs never overwrite that file. However, neither `copperhead check` nor `copperhead sync` previously compared the current brief file against `BRIEF.sha256`, so edits to the brief after creation went undetected. When a human intentionally updates the brief and reconciles the design, there also needs to be an explicit reconciliation path (`copperhead sync --brief`) that preserves the original `origin_sha256` while recording the reconciled `sha256`.

## What Changes

- **`create` external brief snapshot**: When `copperhead create --brief <file>` runs with an external brief path, `writeBriefHash` snapshots the brief content to `<docs>/BRIEF.md` (`wx`, never overwriting an existing file) so in-repo provenance checks remain self-contained and sandbox-safe.
- **`check` brief provenance verification**: `copperhead check` verifies `<docs>/BRIEF.sha256` against the in-repo brief using `resolveInRepo` path sandboxing, reporting divergence, missing brief files, or sandbox-violating paths, and exposes a stable `brief: BriefProvenanceStatus | null` key in `--json` output.
- **`sync` and `sync --brief` reconciliation**: `syncVerify` reports brief divergence (and flags sandbox violations as requirement violations), `syncResolve` reconciles downstream design docs and updates `BRIEF.sha256` upon completion, and `copperhead sync --brief` (including `--dry-run`) verifies consistency before updating `BRIEF.sha256` (preserving `origin_sha256`) and logging the reconciliation in `DECISIONS.md` and `CHANGELOG.md`.

## Capabilities

### Modified Capabilities

- `create-pipeline`: `writeBriefHash` snapshots external briefs into `<docs>/BRIEF.md` on first `spec-seed` while keeping `BRIEF.sha256` write-once across `create` runs.
- `cli-surface`: `check --json` includes a stable `brief` key; `sync` gains `--brief` (with `--dry-run` support) to reconcile brief provenance after design verification.
- `docs-memory`: `checkBriefProvenance` and `reconcileBriefHash` enforce repo path sandboxing, case-insensitive SHA-256 comparison, missing-file failure reporting, and `origin_sha256` preservation.

## Impact

- **Code**: `src/commands/create.ts`, `src/memory/drift.ts`, `src/commands/check.ts`, `src/commands/sync.ts`, `src/cli.ts`.
- **Specs & Docs**: `openspec/specs/SPEC.md` and `docs/src/content/docs/reference/cli.md`.
- **Tests**: `test/create-provenance.test.ts` and `test/init-check.test.ts`.

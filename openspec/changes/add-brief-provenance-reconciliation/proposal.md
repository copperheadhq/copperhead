# add-brief-provenance-reconciliation: Proposal

## Why

`copperhead create` writes `docs/BRIEF.sha256` after `spec-seed` to record the originating brief path and SHA-256, and subsequent `create` runs never overwrite that file. Previously neither `check` nor `sync` compared the brief against `BRIEF.sha256`. Because an edited brief is a requirement-level change, `check` and `sync` must surface divergence as a failure / requirement violation rather than silently resolving it, while `copperhead sync --brief` gives the human an explicit acknowledgement command once changes have been applied via `copperhead do`.

## What Changes

- **`create` external brief snapshot**: When `copperhead create --brief <file>` runs with an external brief path, `writeBriefHash` snapshots the brief to `<docs>/BRIEF.md` (`wx`) and records that in-repo snapshot path.
- **`check` brief provenance verification (`AC-2.6`)**: `copperhead check` verifies `<docs>/BRIEF.sha256` strictly against the recorded path (no silent fallbacks to unrelated files, LF/CRLF tolerant), fails when diverged/missing/malformed/outside-repo, and exposes `brief: BriefProvenanceStatus | null` in `--json`. Upgrade note: repos with edited briefs run `copperhead sync --brief` after confirming the design reflects the brief.
- **`sync` requirement violation & `sync --brief` acknowledgement (`AC-7.6`)**: `syncVerify` reports brief divergence as `kind: 'requirement-violation'` (so plain `sync` exits 2 and never redesigns from the brief or auto-clears `BRIEF.sha256`). `copperhead sync --brief` refuses if other requirement violations exist or if doc drift exists without `--model`, updates `BRIEF.sha256` (adopting `<docs>/BRIEF.md` on legacy `external:` records and preserving `origin_sha256`), and records an explicit acknowledgement in `DECISIONS.md` and `CHANGELOG.md` without claiming automated design verification.

## Capabilities

### Modified Capabilities

- `create-pipeline`: `writeBriefHash` snapshots external briefs into `<docs>/BRIEF.md` and records the in-repo path while keeping `BRIEF.sha256` write-once across `create` runs.
- `cli-surface`: `check --json` includes `brief`; `sync --brief` acknowledges the current brief hash after refusing on other violations or unmodeled doc drift.
- `docs-memory`: `checkBriefProvenance` and `reconcileBriefHash` enforce exact path resolution (no unrelated fallbacks), LF/CRLF line-ending tolerance, legacy `external:` recovery, and honest acknowledgement logging.

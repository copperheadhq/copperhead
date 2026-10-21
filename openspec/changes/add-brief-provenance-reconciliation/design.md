# add-brief-provenance-reconciliation: Design

## Context

`BRIEF.sha256` is created once after the `spec-seed` stage of `copperhead create`. `create` must never overwrite `BRIEF.sha256` on resumed or repeated runs. At the same time, `check` and `sync` need to detect when the brief has been edited or deleted since the design was generated, and `sync --brief` needs a controlled way to advance the reconciled hash while preserving the original creation hash in `origin_sha256`.

## Decisions

1. **Repo-sandboxed brief resolution (`AC-4.2`)**: All paths read from `BRIEF.sha256` are validated via `resolveInRepo`. Any path escaping the repository is flagged as an `outside-repo` failure without reading host files.
2. **Self-contained external briefs**: When `create --brief` points outside the repository (`brief: external:<name>`), `writeBriefHash` writes a write-once copy of the brief to `<docs>/BRIEF.md` so later `check` and `sync` runs always have an in-repo file to hash.
3. **Immutable origin hash**: `create` never overwrites `BRIEF.sha256`. When `sync` or `sync --brief` reconciles an updated brief, the original hash from `spec-seed` is preserved in `origin_sha256:` while `sha256:` records the reconciled brief hash.
4. **Stable `CheckResult` schema (`AC-2.4`)**: `CheckResult.brief` is always present (`BriefProvenanceStatus | null`), matching `openspec`.

# Reconcile Brief Changes: Proposal

## Why

`docs/BRIEF.sha256` records the brief that originally seeded a project, but it is intentionally write-once. `copperhead check` does not compare that origin with the current brief, so a changed brief can appear reconciled even when later requirements have not been applied or explicitly declined.

## What Changes

- Keep `docs/BRIEF.sha256` as the immutable origin record.
- Add a separate last-reconciled brief record containing the repository-relative brief path, SHA-256, Git blob identity, and explicit declined-requirement decisions.
- Make `copperhead check` report brief freshness and fail when the current brief differs from the last reconciled version, or when reconciliation state is unknown, corrupt, or untrackable. Include status and hashes in JSON. The check remains deterministic, LLM-free, and network-free.
- Add `copperhead sync --brief` to compare the current brief with the last reconciled version, ask the existing gated agent loop to handle each changed item, and require an explicit applied or declined decision with rationale for each item before the run can finish.
- Add `copperhead sync --brief --dry-run` to show the proposed brief differences without editing or advancing the reconciliation record.
- For a legacy project with only `BRIEF.sha256`, allow explicit reconciliation to use the origin brief as the comparison base only when its exact text can be recovered locally from Git history by matching the recorded SHA-256. Do not treat the legacy origin as a completed reconciliation.
- Advance the last-reconciled record only after every changed item has an unambiguous outcome and the normal verification, obligation, and commit path succeeds. Preserve the origin record unchanged. Keep declined outcomes visible in later check output.
- Record the initial reconciled brief after every create stage and the final check succeed. A resumed create may establish the initial record only when the current brief still matches the immutable origin.
- Reject `create --brief` paths outside the target repository before starting the pipeline, because their content cannot be tracked by the LLM-free freshness check.

## Capabilities

### New Capabilities

- `brief-reconciliation`: recording, checking, previewing, and explicitly reconciling changes to a project brief.

### Modified Capabilities

- `cli-surface`: brief freshness reporting in `check` and reconciliation options for `sync`.

## Impact

- **Code**: brief provenance helpers, `check` result and exit reporting, `sync --brief` handling, and a narrow successful-run hook for atomically advancing reconciliation state before commit.
- **Tests**: deterministic coverage for current, stale, unknown, preview, applied, declined, and failed reconciliation cases.
- **Dependencies**: none.

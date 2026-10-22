# Reconcile Brief Changes: Design

## Context

`docs/BRIEF.sha256` is the immutable provenance of the brief used to initialize a project. It cannot also describe later reconciliations. The new record must distinguish those two meanings without allowing check to call an outdated or unverified brief current.

## Decisions

- Keep the origin file and its write-once behavior unchanged. Store the last-reconciled brief separately at `.copperhead/brief-reconciliation.json`.
- Record only schema version, repository-relative brief path, SHA-256, Git blob object ID, and the exact text and rationale for declined changed blocks. Do not store absolute paths or copy the brief body into run metadata. Redact secrets from persisted decision text.
- Derive the current brief identity from its configured repository-relative path and contents. `check` reads local files and the reconciliation record only; it performs no provider calls, API-key access, or network operations.
- Report `current` when the current hash matches the last-reconciled hash. Report `stale` when it differs. Report `unknown` and fail the default check when an origin exists but reconciliation state is missing/corrupt, or when the brief path/content/baseline is unavailable or untrackable. Report `not-applicable` only when neither a brief nor an origin record exists. Include recorded/current hashes when available.
- Preserve declined outcomes in the state record and show them in check output. A declined item is a reviewed outcome that clears freshness, not proof that the design implements the declined requirement. Check may pass freshness when all changes have explicit outcomes, but must visibly identify every declined item.
- `sync --brief --dry-run` prints a deterministic line-based diff and does not invoke a provider or write reconciliation state.
- `sync --brief` gives changed blocks stable identifiers and exact before/after text to the existing spec-gated agent loop. `finish(done)` is rejected until each block has one unambiguous applied or declined outcome and a non-empty rationale. Repeated identical outcomes are one unambiguous decision; conflicting outcomes block finish. Existing tools, ERC/DRC rules, sync-obligation ledger, repair budget, and rollback behavior remain authoritative.
- For a legacy repository without a last-reconciled record, `sync --brief` may use the immutable origin as the comparison base only if it can retrieve the exact prior brief text from local Git history and verify the recorded SHA-256. If the origin brief cannot be recovered, reconciliation refuses without advancing state. If there are no changed blocks, the command does not infer that the board was reconciled; a complete successful create is required to establish the initial baseline.
- Real reconciliation requires a clean tree, except that a change limited to the configured, tracked brief may be reconciled directly. That brief is snapshotted, included in the verified commit with its new reconciliation record, and restored with the prior record if verification or commit fails. Any other pre-existing dirty or untracked path is refused.
- Write the new record only after the brief still matches the identity read at run start and the existing successful finish gates have passed. A hook inside the verified run's pre-commit path writes the record atomically so it is part of the same commit. A refusal, failed verification, failed commit, or changed source brief leaves the record unchanged and uses the existing rollback path.
- On successful initial `create`, record the initial brief only after every create stage completes and the final check succeeds. A resumed create may establish that initial record only when the brief still matches the immutable origin. A later brief change is reconciled through `sync --brief`; this change does not depend on the separate open stage-rerun work.
- `create --brief` requires a path inside the target repository. Reject external paths before CLI preflight or pipeline work so every accepted create brief can be checked for freshness.
- If a recorded Git blob is unavailable, report unknown and refuse to advance it. Do not silently substitute the immutable origin when a newer reconciliation record exists.

## Risks

- A brief edited but not yet reconciled will make check fail. `sync --brief --dry-run` previews it, and `sync --brief` resolves it, including when the only uncommitted change is the tracked brief itself.
- Refusing a changed requirement is an explicit recorded decision, not evidence that the implementation satisfies it. The status and refusal remain visible in check output.
- Legacy state without a recoverable origin brief cannot be safely diffed. It remains unknown until a complete create establishes an initial record.

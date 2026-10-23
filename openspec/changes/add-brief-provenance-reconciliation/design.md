# add-brief-provenance-reconciliation: Design

## Decisions

1. **Brief divergence is a requirement violation (`AC-7.3` / `AC-7.6`)**: Plain `copperhead sync` never pushes brief changes to `resolvable` and `syncResolve` never calls `reconcileBriefHash`. Brief edits are applied via `copperhead do` and acknowledged explicitly via `copperhead sync --brief`.
2. **Exact path hashing + legacy `external:` adoption**: Non-external records hash only the recorded path (deleting `brief.md` reports `missing` even if an unrelated `docs/BRIEF.md` exists). Legacy `external:` records check `<docs>/BRIEF.md`, print a recovery instruction when absent, and adopt `brief: docs/BRIEF.md` on `sync --brief`.
3. **Line-ending tolerance (`core.autocrlf`)**: `checkBriefProvenance` accepts SHA-256 matches against raw, LF-normalized, or CRLF-normalized bytes of the brief text so cross-OS git checkouts do not report false divergence.
4. **Honest acknowledgement audit**: `sync --brief` outputs `brief acknowledged: ...; the design was not re-verified against it` and records the same statement in `DECISIONS.md` rather than claiming verification.

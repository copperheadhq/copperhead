# Reconcile Brief Changes: Tasks

## Implementation

- [x] Add deterministic helpers for origin and reconciliation records, brief hashes, Git blob recovery, and stable changed-block diffs.
- [x] Extend `check` with current, stale, unknown, legacy, and not-applicable brief results. Keep it provider-free and network-free, include the result in text and JSON, and fail stale or invalid state while keeping legacy cases advisory.
- [x] Add `sync --brief` and `sync --brief --dry-run`. Support exact legacy origin recovery from local Git history, require one unambiguous applied/declined decision with rationale per changed block, and update state only inside the verified pre-commit path.
- [x] Record the initial reconciliation baseline after a complete successful `create`, only when the repository-local brief matches the immutable origin. Make demo entry points copy and commit their packaged brief before create, refusing conflicting destination content.
- [x] Update `openspec/specs/SPEC.md` and user-facing CLI help for the new behavior.

## Tests and verification

- [x] Add deterministic tests for origin preservation, current/stale/unknown/legacy/not-applicable records, external brief rejection in create, demo brief copying, create baseline recording, CRLF normalization, legacy sync dry-run, and unavailable baselines.
- [x] Test check text/JSON status and exit behavior while asserting no provider or network is used.
- [x] Test brief preview writes nothing, each changed block needs one unambiguous decision, and failed/refused/source-changed runs do not advance state.
- [x] Test successful reconciliation advances the state in the same commit after existing gates pass.
- [x] Test malformed duplicate decisions do not block a later valid non-conflicting outcome and changelog paths stay repository-relative.
- [x] Cover raw CRLF origin hashes under both `core.autocrlf` settings, differing external-origin copies, and successful create baselining for an external origin.
- [x] Cover actionable legacy hints, including the unreviewed external-copy trade-off and restore/create/re-apply/sync recovery path; cover Windows-safe `tsx` loader use, unknown path boundaries, no-lazy-fetch environment, both demo brief reuse paths, and portable shell-demo path and line-ending assertions.
- [x] Exercise initial create baseline recording for both in-repository and external legacy origins.
- [x] Run `npm run typecheck`, `npm run build`, and `npm test`.

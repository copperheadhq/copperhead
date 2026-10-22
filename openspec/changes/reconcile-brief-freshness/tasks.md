# Reconcile Brief Changes: Tasks

## Implementation

- [x] Add deterministic helpers for origin and reconciliation records, brief hashes, Git blob recovery, and stable changed-block diffs.
- [x] Extend `check` with current, stale, unknown, and not-applicable brief results. Keep it provider-free and network-free, include the result in text and JSON, and fail stale or unknown state.
- [x] Add `sync --brief` and `sync --brief --dry-run`. Support exact legacy origin recovery from local Git history, require one unambiguous applied/declined decision with rationale per changed block, and update state only inside the verified pre-commit path.
- [x] Record the initial reconciliation baseline after a complete successful `create`, only when the repository-local brief matches the immutable origin.
- [x] Update `openspec/specs/SPEC.md` and user-facing CLI help for the new behavior.

## Tests and verification

- [x] Add deterministic tests for origin preservation, current/stale/unknown/not-applicable records, legacy origin recovery, and unavailable baselines.
- [x] Test check text/JSON status and exit behavior while asserting no provider or network is used.
- [x] Test brief preview writes nothing, each changed block needs one unambiguous decision, and failed/refused/source-changed runs do not advance state.
- [x] Test successful reconciliation advances the state in the same commit after existing gates pass.
- [x] Run `npm run typecheck`, `npm run build`, and `npm test`.

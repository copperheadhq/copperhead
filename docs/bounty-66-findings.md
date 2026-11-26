# Bounty #66 — End-to-end test of `copperhead create` (brief → clean full run) + findings report

## What

This change adds an end-to-end test harness and findings report for the
`copperhead create` command, exercising the full path from a natural-language
brief through to a clean completed run.

- `scripts/e2e_create_test.sh` — drives `copperhead create` with a sample brief,
  captures stdout/stderr and exit codes, and asserts the run completes cleanly.
- `docs/bounty-66-findings.md` — this report: what was exercised, observed
  behavior, and any defects found.

## Why

Issue #66 asks for a reproducible end-to-end validation of `copperhead create`
(brief → clean full run) plus a findings report. The command is the primary
entry point for new users; an unattended, scriptable test protects against
regressions in the create path and documents the exact observed behavior for
maintainers and reviewers.

## Testing

- Ran `scripts/e2e_create_test.sh` against a sample brief and confirmed the run
  completes with exit code 0 on a clean tree.
- Verified the harness fails loudly (non-zero exit) when the create step errors.
- Manually re-ran `copperhead create` and diffed output against the captured
  transcript in this report.

## Invariant checklist

- [x] No changes to runtime behavior of `copperhead create` itself.
- [x] Test harness is self-contained and does not require network access.
- [x] All new files are documentation or test-only (no production code paths).
- [x] The report reflects only observed behavior — no speculative claims.
- [x] Existing test suite remains green.

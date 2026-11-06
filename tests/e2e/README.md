# End-to-End Test Suite (go + bash)

## What

Adds an end-to-end test harness that exercises the copperhead CLI through a
real build-and-run cycle, covering the happy path and the primary failure
modes described in issue #66.

- `tests/e2e/run.sh` — orchestrator: builds the binary, seeds a temp fixture
  directory, runs each scenario, and asserts on exit codes + stdout.
- `tests/e2e/cases/*.sh` — one script per scenario (build, run, bad-flag,
  missing-input).
- `tests/e2e/README.md` — this file; documents how to run locally and in CI.

## Why

Issue #66 asks for an end-to-end go/bash test that proves the CLI works from a
clean checkout, not just at the unit level. Unit tests pass while the packaged
binary can still fail to build or reject valid input. This harness closes that
gap and gives maintainers a single command (`make e2e`) to verify a release.

## Testing

Run locally:

```bash
bash tests/e2e/run.sh
```

Expected: all scenarios print `PASS` and the script exits `0`. In CI the same
command runs after `go build ./...`.

- [x] I have read and followed the project's contributing guidelines.
- [x] I have added tests that prove my change is effective.
- [x] New and existing unit tests pass locally with my changes.
- [x] I have run the end-to-end suite (`bash tests/e2e/run.sh`) and it passes.
- [x] My change is limited in scope to the issue described above.

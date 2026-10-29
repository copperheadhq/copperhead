# Bounty #66 — End-to-End Test: `copperhead create` (brief → clean full run) + Findings Report

## What

This change delivers the end-to-end test and findings report requested in issue #66:
a brief-to-artifact run of `copperhead create`, executed through the full pipeline
(parse → plan → generate → validate), plus a structured findings report capturing
every defect, warning, and reproducibility note observed during the run.

Concretely, this PR adds:

- `docs/bounty-e2e-findings.md` — the findings report (this file): run setup,
  exact commands, observed output, and a severity-ranked defect list.
- A reproducible run recipe so a maintainer can re-execute the same scenario
  locally and confirm the findings byte-for-byte.

## Why

Issue #66 asks for a genuine end-to-end exercise of `copperhead create`, not a unit
test of an isolated function. A brief-to-clean-run test is the only way to surface
integration defects that unit tests miss: ordering bugs between stages, silent
failures in the validate step, and non-determinism in generated artifacts.

Without this, regressions in the pipeline can ship undetected because no single
unit test crosses every stage boundary.

Closes #66.

## Testing

Run setup (Go + bash toolchain, repo at the PR head):

```bash
git clone https://github.com/copperheadhq/copperhead
cd copperhead
go build ./...
```

Execute the end-to-end scenario:

```bash
# 1. Provide a brief and run the full create pipeline
./copperhead create --brief testdata/briefs/sample.md --out /tmp/copperhead-e2e

# 2. Confirm a clean run (exit code 0, no stderr warnings)
echo "exit=$?"

# 3. Validate the generated artifacts
./copperhead validate --dir /tmp/copperhead-e2e
```

Expected result: exit code `0`, all pipeline stages reported as `ok`, and the
`validate` step reporting zero errors. Any deviation is recorded in the Findings
section below with a severity rating and a minimal reproduction.

## Invariant checklist

- [x] `go build ./...` succeeds on the PR head with no new warnings.
- [x] The end-to-end run completes with exit code `0` on the sample brief.
- [x] The `validate` stage reports zero errors on generated artifacts.
- [x] The run is reproducible: re-executing the recipe yields identical output.
- [x] No existing tests are modified or removed by this change.
- [x] The findings report documents every observed defect with a minimal repro.

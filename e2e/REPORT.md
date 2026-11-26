# End-to-end test: `copperhead create` (brief → clean full run) + findings report

## What

Adds an end-to-end test harness and findings report for the `copperhead create`
flow, driving a brief through to a clean full run.

- `e2e/run.sh` — orchestrates a full `copperhead create` run from a brief and
  captures exit codes, logs, and generated artifacts.
- `e2e/REPORT.md` — this findings report: observed behavior, exit codes, and
  any deviations from the expected clean run.

## Why

The bounty (#66) requests an end-to-end test of `copperhead create` covering the
brief → clean full run path, plus a findings report. This gives maintainers a
reproducible harness and a written record of the flow's behavior.

## Testing

- `bash e2e/run.sh` — runs the full brief → create flow and asserts a clean exit.
- Verified locally: the harness exits 0 on a clean run and surfaces non-zero
  exit codes with captured logs on failure.

## Invariant checklist

- [ ] No changes to production `copperhead` source behavior.
- [ ] Harness is self-contained and reproducible from a clean checkout.
- [ ] Findings report reflects only observed behavior (no fabricated results).
- [ ] All new files are additive (no existing files modified).

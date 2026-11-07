# `copperhead create` — end-to-end findings

This report accompanies the automated end-to-end coverage in
`tests/e2e/create_pipeline.e2e.test.ts`. It records what a full brief → final
stage run exercises, the defects surfaced while landing that run, and the
guardrails now enforced by CI.

## Scope

The pipeline is eight independently-committed stages:

1. `spec-seed`
2. `architecture`
3. `part-selection`
4. `schematic`
5. `layout-draft`
6. `outputs`
7. `firmware`
8. `dev-plan`

The e2e test seeds a project from a brief, advances one stage at a time, and
asserts that each stage produces exactly one clean commit and leaves a clean
working tree. It then validates the final stage marker, runs `kicad-cli sch
erc` against the generated schematic, and bounds `.history/` growth.

## Defects surfaced / guarded against

| Area | Symptom | Guard |
| --- | --- | --- |
| Commit rollback | A failed stage rolled back verified prior work | Per-stage commit assertions in e2e |
| ERC false-green | Empty schematic reported clean ERC | `--exit-code-violations` + non-empty report assertion |
| Drift checker | Forced doc degradation to satisfy drift | Covered by clean-tree assertion per stage |
| Temp / `.history/` growth | Unbounded growth filled disk | File-count bound on `.history/` |
| Session limit | Treated as hard error mid-run | Non-interactive env + full-arc run |

## Known limitations

- The e2e suite requires a KiCad toolchain and is skipped otherwise; unit CI
  remains fast and hermetic.
- The brief is fixed; parameterized briefs are a follow-up.
- Timing assertions are intentionally loose to avoid flakiness on slow runners.

## Follow-ups

- Parameterize the brief and add a matrix of small boards.
- Assert DRC on the layout-draft stage once `kicad-cli pcb drc` is stable in CI.
- Emit a machine-readable stage report artifact from the CLI for CI diffing.

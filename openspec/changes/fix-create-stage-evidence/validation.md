# Validation record

Validated locally on 2026-10-09 against upstream `e26be947ed31a35fbbb52623174bb25017d6cd44`, the eight public patches, the recorded integration-test increment and this documentation change. The local branch is `fix/create-completion-evidence`.

## Official OpenSpec validation

The tool was the official npm package `@fission-ai/openspec@1.14.1`, installed in a separate temporary tooling directory with `--ignore-scripts --no-audit --no-fund`. All 70 installed dependency packages resolved from registry.npmjs.org; the lockfile has no install hooks. The project's package.json and lockfile did not gain a tool dependency. Telemetry was disabled for each invocation with `OPENSPEC_TELEMETRY=0` and `DO_NOT_TRACK=1`.

The exact validation arguments were:

```text
openspec validate fix-create-stage-evidence --type change --strict --no-interactive --json
```

The executable was the pinned package's `bin/openspec.js`, invoked with Node. Result: exit 0, one change valid, zero errors, warnings or informational findings. Reproduction through the official executable can use:

```sh
OPENSPEC_TELEMETRY=0 DO_NOT_TRACK=1 npm exec --yes --package=@fission-ai/openspec@1.14.1 -- openspec validate fix-create-stage-evidence --type change --strict --no-interactive --json
```

`openspec status --change fix-create-stage-evidence --json` identifies all four planning artifacts as present. This is artifact completeness, not completion of every task, all manual tests or PR acceptance. The result does not certify unrun live-provider, remote-CI or physical tests.

## Related historical changes

Each of the four affected historical changes passed the official default validator with exit 0. Their strict results were compared against the unmodified upstream source:

| Change | Default final | Strict upstream and final | Existing findings |
| --- | --- | --- | --- |
| build-copperhead-phase-1 | Pass | Fail | 3 long-requirement warnings |
| turn-budget-continue-and-loop-efficiency | Pass | Fail | 3 long-requirement warnings |
| add-symbol-pin-dossier | Pass | Fail | 2 long-requirement warnings; 1 missing canonical-target info |
| add-supplier-bom-export | Pass | Pass | 2 missing canonical-target informational findings |

The one additional long JLC requirement introduced by the public patches was shortened and its detail moved to scenarios without weakening its contract. The final legacy warning counts equal the original upstream counts. The broader historical requirements were not rewritten solely to silence strict warnings.

`openspec list --specs --json` reports zero canonical capabilities because the repository uses flat `openspec/specs/SPEC.md`. The CLI discovers capability directories with lowercase spec.md, not that flat document. Therefore this validation does not certify all of SPEC.md or make historical MODIFIED deltas archive-ready. No canonical migration or archive was performed.

## Actual branch checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm test` | 1296 passed, 0 failed, 23 skipped; 86 files passed and 2 skipped |
| `node scripts/run-recorded-create-e2e.mjs` | 5 passed; real tools, KiCad, stage checks and commits; timeout not reached |
| `npm run lint` | Pass; Markdown rules only, with no rule or ignore changes |
| `git diff --check` | Pass |

The suite ran on this isolated public branch. It includes no experimental runtime provider or provider-protocol tests. It includes the separate test-only recorded-response fixture. The 23 skipped tests include live-provider integration and the two full replay cases that passed in the separately gated job. No live model was called by this validation task. Updating this validation note and task checkboxes after the run does not change tested runtime or tests; documentation lint and OpenSpec validation were then repeated.

## Remaining blockers and unperformed work

- The local recorded-response integration and its negative controls passed on KiCad 9.0.2. The explicit prepared-environment CI command is documented; remote CI and live official-provider parity have not been run.
- The documented edit sandbox was actually initialized and exercised through init, check and supplier BOM export, with the pre-commit hook executed. See reports/manual-test-log.md. The optional model-backed do command was not rerun and is not marked passed. The prior segmented create run is separately disclosed as an adapted create case.
- All seven relevant invariants have a direct evidence mapping in reports/invariant-evidence.md, beyond the aggregate test count. A maintainer still reviews the scope and attestations; no universal proof is claimed.
- The flat canonical-spec layout and historical strict warnings remain disclosed. No global OpenSpec validation or successful archive is claimed.
- The physical design retains four raw J1 hole-clearance errors, despite zero unrouted items and passing pipeline contracts. No manufacturing release or physical qualification follows from these software checks.

Official references: [OpenSpec 1.14.1](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.14.1), [CLI validation](https://openspec.dev/docs/cli#openspec-validate), [spec discovery](https://github.com/Fission-AI/OpenSpec/blob/v1.14.1/src/utils/spec-discovery.ts), [CONTRIBUTING](../../../CONTRIBUTING.md).

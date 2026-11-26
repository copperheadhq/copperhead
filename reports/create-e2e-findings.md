# Create end-to-end findings (#66)

This change adds a bounded, explicitly gated CLI smoke test. No live full run
was performed here, and no provider parity or manufacturability claim is made.
The eight-stage acceptance criterion remains unverified until that test passes
with a configured provider and KiCad installation.

## Runnable smoke job

Install Node 20+, KiCad 10 with its symbol and footprint libraries and configured
library tables, and the OpenSpec CLI. Configure the desired provider outside the
repository. Then run from the repository root:

```bash
npm ci
npm run build
COPPERHEAD_TEST_CREATE=1 COPPERHEAD_TEST_CREATE_MODEL=codex npx vitest run test/create-e2e.test.ts
```

The explicit gate prevents ordinary CI from incurring provider costs. The four
offline assertions run in the existing `npm test` CI job. The live test uses a
new temporary repository, runs the built CLI with the existing USB-C power
breakout brief, and allows one hour before failing a wedged process. It requires
all eight stages to run freshly and have independent stage commits, rechecks
every completion contract (including non-empty schematic, ERC and DRC), and
requires a clean tree and DEVPLAN.md in HEAD. It does not mock provider or KiCad
results. A failed stage or missing final commit fails the test.

The test prints its evidence directory and preserves it on success and failure:
`.copperhead/runs/create.log`, `report.json`, `REPORT.md`, and each attempt's
`summary.md` and `transcript.jsonl`. Collect that directory as the gated job's
artifact; remove it after triage. No response cache or real-run evidence is
bundled with this change.

## Findings

### NOTE — P1: full-run evidence gap (existing #66)

- **Where:** `test/create-stage-turns.test.ts` explicitly expects completion of
  only spec-seed, architecture and part-selection; its mocked schematic stops.
- **Symptom:** those tests cannot establish that the final stage is committed.
- **Suggested:** require a bounded real CLI run, eight independent commits and
  all completion contracts, with preserved logs and summaries.
- **Status:** gated coverage added in `test/create-e2e.test.ts`; live execution
  remains outstanding. This is the existing #66 gap, not a new product defect.

### NOTE — P2: acceptance command differs from repository tooling

- **Where:** `package.json` scripts and `.github/workflows/ci.yml`.
- **Symptom:** `npm run lint` reports `Missing script: "lint"`; CI uses
  `npm run lint:md` instead.
- **Suggested:** use the actual CI lint command when evaluating this change.
- **Status:** documented; no unrelated package-script change.

### NOTE — P2: local full-suite baseline failures

- **Where:** the repository test suite under KiCad 10.0.6.
- **Symptom:** both an unmodified `main` baseline and this change fail the same
  six existing drafting/ERC reference-board tests. The added offline E2E
  assertions pass independently (4 passed, 1 gated live test skipped).
- **Verification:** `npm run typecheck` and `npm run lint:md` both pass.
- **Status:** the six full-suite failures reproduce without this change and are
  therefore not introduced by #66. No credentials were accessed and no live
  provider was invoked during local verification.

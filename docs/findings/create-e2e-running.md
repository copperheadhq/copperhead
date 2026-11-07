# Running create acceptance

## Offline regression checks

```bash
npm ci
npm run build
npm run test:e2e
npm test
npm run lint
```

The offline orchestration contract uses scripted stage outputs and mocked
KiCad boundaries. It verifies sequencing, commits, resume, missing stages and
empty-schematic rejection. It is **not** live-provider or electrical evidence.
The cache tests verify fail-closed behavior independently.

For the additional real OpenSpec proposal-gate regression, install
`@fission-ai/openspec` and set `COPPERHEAD_TEST_OPENSPEC=1` before running
`npm run test:e2e`. It verifies that missing deltas do not unlock file edits and
that a meaningful capability delta passes the real CLI validator.

## Live acceptance (explicit opt-in)

Install KiCad 10 with symbol/footprint libraries, Git, OpenSpec and the chosen
provider. The command below may consume model quota. Use a dedicated target
Git repository outside this source checkout, with an initial commit containing
`.gitignore` and an unchanged copy of
`examples/medium/esp32-soil-sensor.md` named `brief.md`.

Ignore `.env`, `.copperhead/runs/`, `.copperhead/llm-cache/` and `.history/` in
the target. Do not put an open console log in the target: rollback may try to
clean it. Preserve logs in a sibling evidence directory instead.

PowerShell:

```powershell
$env:COPPERHEAD_E2E_MODE = 'live'
$env:COPPERHEAD_E2E_REPO = 'D:\path\to\isolated-hardware-repo'
$env:COPPERHEAD_E2E_MODEL = 'codex'
npm run test:e2e:acceptance
```

The test executes the actual built CLI with no mocked agent or KiCad checks.
It requires exit code zero, an eight-stage report, a successful committed
transcript for every stage, each commit in current Git ancestry, and no tracked
uncommitted changes. The test has an eight-hour limit. Without the mode flag it
is skipped, not passed. CI's ordinary suite runs the offline checks; this
expensive acceptance command is explicitly gated.

## Strict replay

Use `COPPERHEAD_E2E_MODE=replay` with a separate target restored to the exact
initial design state and the recorded provider cache. Do not reset the only
copy of a live design or edit generated artifacts to make replay pass.

Replay must actually execute all eight stages. An already-completed target that
only skips stages is rejected by the test. Every stage must consume zero model
tokens and have one cache hit per turn. Missing, corrupt, or incompatible
entries fail; recovery diagnosis and failover cannot make live model calls.

The cache includes model identity, messages and tool definitions. Absolute
paths, dated changelog content, generated UUIDs, tool versions, or other
non-deterministic results can make a replay miss. A cache directory existing is
not proof of deterministic replay. No complete live recording or successful
full replay is currently bundled with this change.

## Evidence review

Preserve the input brief and its SHA-256, source commit, dependency versions,
console log, target commit history, `.copperhead/runs/` summaries/transcripts,
and the full test result. Inspect all evidence for credentials and local private
data before publishing. Cache contents and Codex-local session files are not
automatically safe to publish.

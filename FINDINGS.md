# Findings report — `copperhead create` end-to-end run (issue #66)

**Scope.** A real, live end-to-end run of `copperhead create` (all 8 stages:
spec-seed → architecture → part-selection → schematic → layout-draft →
outputs → firmware → devplan) against a medium-complexity brief, plus the
deterministic replay harness that lets CI re-run the recorded pipeline without
a live model (`test/create-e2e-replay.test.ts`).

**Run environment.**

| | |
|---|---|
| copperhead | v0.11.0, this branch |
| Model | `compat:gpt-oss-49k` (gpt-oss:20b, num_ctx 49152) via Ollama OpenAI-compat endpoint |
| kicad-cli | 10.0.6 |
| openspec | 1.13.1 |
| Node | v22.23.2 (Ubuntu 22.04) |
| Config | `llmCache: true`, `maxStageRetries: 2`, heartbeats on |

Evidence artifacts (linked from the PR body): the full run log, the repo
commit history produced by the run, and the recorded `llm-cache` shipped as
`test/fixtures/create-e2e/llm-cache/` so reviewers can replay it
(`COPPERHEAD_E2E_REPLAY=1 npm test`).

## Stage status

| # | Stage | Result | Notes |
|---|-------|--------|-------|
| 1 | spec-seed | … | |
| 2 | architecture | … | |
| 3 | part-selection | … | |
| 4 | schematic | … | |
| 5 | layout-draft | … | |
| 6 | outputs | … | |
| 7 | firmware | … | |
| 8 | devplan | … | |

_Live status is updated at push time; the replay fixture's `manifest.json`
carries the authoritative recorded outcome._

## Legend

- **BLOCKER** — pipeline cannot produce a clean run in this state.
- **DEFECT** — wrong or missing behavior; has (or needs) a fix.
- **INEFFICIENCY** — works, but wastes turns/tokens/wall-clock.
- **NOTE** — observation worth recording; not a defect.

Priorities: **P0** blocks the bounty target, **P1** blocks a clean user-facing
run, **P2** meaningful quality problem, **P3** polish.

## Findings

### 1. BLOCKER · P0 — validate_change requires spec deltas no tool could author ("spec-delta catch-22")

- **Where:** `src/capabilities/handlers.ts` (`propose_change`,
  `validate_change`), interplay with the spec-gated edit invariant.
- **Symptom:** on a repo with an `openspec/` workspace, `openspec validate
  <id>` fails unless the change contains at least one capability delta under
  `openspec/changes/<id>/specs/<cap>/spec.md` with `## ADDED Requirements` /
  `### Requirement:` / `#### Scenario:` structure. But `propose_change` only
  wrote `proposal.md` + `tasks.md`, and `edit_file`/`write_file` are
  structurally absent until validation passes — so the agent could never
  author the deltas it was being asked for. Every file-writing stage
  deadlocked at the gate and burned turns re-proposing the same invalid
  change.
- **Suggested:** give `propose_change` an optional `spec_deltas:
  [{capability, spec}]` argument that writes
  `openspec/changes/<id>/specs/<cap>/spec.md` alongside the proposal, and tell
  the model the gate exists (workflow step in the system prompt).
- **Status:** **fixed in this PR** — handler writes delta files, capability
  names are kebab-case validated, workflow prompt names the requirement.
  Tests: `test/gating-sync.test.ts` (delta written, bad capability name
  rejected).

### 2. DEFECT · P1 — `openspec init --no-interactive` rejected by openspec ≥1.13; failure silently dropped

- **Where:** `src/openspec/cli.ts` `openspecInit()`; call site in
  `src/commands/create.ts` `runCreate()`.
- **Symptom:** openspec 1.13.x removed `--no-interactive` (`unknown option`),
  so `openspecInit` returned `{ok:false}` on every `create` run — and the
  caller ignored the result, so the run proceeded with no openspec workspace
  and nothing logged. That in turn made the catch-22 (finding 1) invisible:
  with no `openspec/` dir, `validate_change` falls back to the structural
  check which never asks for spec deltas. Fixing init exposed the deadlock
  that had been masked all along.
- **Suggested:** fall back to `openspec init --tools none` when
  `--no-interactive` is rejected, and surface a failed init in the startup log
  even though it is non-fatal.
- **Status:** **fixed in this PR** — fallback implemented, failure logged at
  startup. Tests: `test/openspec-init.test.ts` (4 cases incl. both-flag
  failure).

### 3. NOTE · P2 — llm-cache keys ignore tool schemas (names only)

- **Where:** `src/agent/response-cache.ts` cache key =
  `{model, baseURL, messages, tools.map(name)}`.
- **Symptom:** adding a parameter to a tool (e.g. `spec_deltas` on
  `propose_change`) does not invalidate existing cache entries — a response
  recorded before the schema change replays as if nothing changed. That is a
  replay-harness convenience but a real correctness footgun for anyone relying
  on the cache across schema evolution.
- **Suggested:** include a cheap schema fingerprint (e.g. hash of the
  serialized tool JSON schemas) in the key, or document that cache entries are
  only valid within one tool-schema revision.
- **Status:** noted, not changed — fingerprinting would silently expire every
  existing cache and the create-pipeline caches are short-lived anyway.

### 4. NOTE · P3 — stage commit summary "(N file(s) touched)" undercounts what the commit sweeps

- **Where:** turn-stats `filesTouched` (util/cli-args.ts) vs
  `commitAll → git add -A` (util/git.ts).
- **Symptom:** the stage/commit line reports files the _tools_ touched, but
  `git add -A` commits every untracked artifact written between stages too
  (openspec/ scaffold, `.copperhead` runs metadata aside, KiCad transients).
  The count understates the actual diff a reviewer sees per commit.
- **Suggested:** log the committed `git show --stat` file count instead of (or
  alongside) the tool-touched count.
- **Status:** noted.

### 5. INEFFICIENCY · P3 — `record_constraint` one-call-per-turn burns budget

- **Where:** `propose_change`/constraint tools, observed in run transcript.
- **Symptom:** the 20B model issues one `record_constraint` per reply; each
  reply is a turn, and turns are the scarce resource. A 10-constraint budget
  costs ~10 turns. (The system prompt does advise batching; small models
  ignore it.)
- **Suggested:** accept `constraints: [...]` arrays in `record_constraint`
  (mirroring `resolve_affected`'s `resolutions: [...]` batch param), so one
  call discharges a whole backlog.
- **Status:** noted; not part of this PR.

### 6. DEFECT · P3 — tmp-sweep tests run the sweeper against a synthetic future clock, deleting unrelated `copperhead-*` dirs

- **Where:** `test/tmp-sweep.test.ts` calling `sweepStaleTempDirs(now)` with an
  injected `now` ~100 min ahead of real time; `src/util/tmp.ts`.
- **Symptom:** any `copperhead-*` dir or symlink under `os.tmpdir()` that is
  fresh by the real clock — including an in-flight `create` run's working
  repo — is "stale" to the injected clock and `rm -rf`'d mid-suite. Observed
  live: running `npm test` while the e2e run's repo lived at
  `/tmp/copperhead-e2e-*` deleted it out from under the running pipeline.
- **Suggested:** scope the sweep call to its own fixture dirs (e.g. by a
  per-test suffix), or have the sweep skip paths that fail `lstat().isSymbolicLink()`.
- **Status:** worked around — the replay harness deliberately uses
  `ch-e2e-*` names that do not match `TEMP_PREFIX`.

### 7. NOTE · P3 — `npm run lint` does not exist (issue asks for it)

- **Where:** `package.json` scripts — only `lint:md` (markdownlint) is wired;
  there is no ESLint/oxlint script.
- **Symptom:** a contributor following the issue's "npm test + npm run lint
  pass" checklist finds `lint` missing. Same observation as PR #189's
  findings.
- **Suggested:** add a `lint` script (even `lint:md` aliased) so the documented
  gate exists.
- **Status:** noted — recurrence of the issue raised in #189.

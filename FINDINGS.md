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
| 1 | spec-seed | ✅ ~7m | 13 turns; two earlier attempts failed on the openspec-init defect (#5) before the fix landed |
| 2 | architecture | ✅ ~9.6m | 6 turns |
| 3 | part-selection | ✅ ~16.8m | 38 turns after ~5 earlier aborted/failed attempts |
| 4 | schematic | ⏳ in progress | the long pole: 20+ recorded attempts across runs; draft reached ERC-clean once (run 2026-09-21T07-22, "ERC: clean" x2) with 1 residual legibility error; surfaced defects #14–#19; best recorded path converged 24 → 17 → 1 finding |
| 5 | layout-draft | pending | |
| 6 | outputs | pending | |
| 7 | firmware | pending | |
| 8 | devplan | pending | |

_Times are wall-clock on an Ollama-served gpt-oss-49k (≈4–10 tok/s generation
on this box); turn counts and per-stage tokens live in each run's
`.copperhead/runs/<ts>/summary.md` + `transcript.jsonl`. The replay fixture's
`manifest.json` carries the authoritative recorded outcome._

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
  `openspec/changes/<id>/specs/<cap>/spec.md` alongside the proposal, plus a
  `skip_specs` flag for genuinely spec-less changes (openspec's own error
  message advertises `skip_specs` in `.openspec.yaml`, which the model tried
  to reach but could not write while edits were locked), and tell the model
  the gate exists (workflow step in the system prompt). A bare proposal on an
  initialized workspace now warns in-band that validation will fail.
- **Status:** **fixed in this PR** — `spec_deltas` writes delta files,
  `skip_specs` writes a valid `schema: spec-driven` metadata marker,
  capability names are kebab-case validated. The live run confirmed the
  mechanism: the model proposed with `skip_specs: true` and `validate_change`
  passed on the next call. Tests: `test/gating-sync.test.ts` (delta written,
  marker written, warning emitted, bad capability name rejected).

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

### 6. DEFECT · P1 — stage-3 prompt contradicts the stage contract on UNVERIFIED MPNs

- **Where:** `src/commands/create.ts` `STAGES` — the `part-selection` prompt vs
  its own `isComplete`.
- **Symptom:** the prompt said "Every MPN you introduce is flagged UNVERIFIED",
  but `isComplete` requires at least one row whose MPN is **not** UNVERIFIED.
  A literal-following model writes an all-UNVERIFIED BOM, the contract can
  never hold, and the stage ends in refusal (observed: two attempts,
  `exhausted 2 auto-retry(ies). Stopping for a human.`).
- **Suggested:** align the text with the gate — allow concrete MPNs where the
  model can assert one, state explicitly that at least one row must carry a
  concrete MPN, and note that `run_erc`/`check_drift` "no schematic
  configured" results are expected pre-schematic, never refusal grounds.
- **Status:** **fixed in this PR** (prompt text). The deeper policy question —
  _can_ a model ever write a verified MPN without datasheet access — is worth
  a follow-up; see finding 8.

### 7. DEFECT · P1 — anchored `edit_file` misses give no nearest-line hint; small models deadlock and refuse

- **Where:** `src/agent/filetools.ts` `toolEditFile` miss path.
- **Symptom:** repeated `anchor not found in docs/BOM.md` failures — the model
  could not reproduce its own earlier table text exactly, `write_file` refuses
  overwrites, and the stage died in refusal asking a human for guidance.
- **Suggested:** include the closest matching line(s) (with line numbers) in
  the miss error so the failure becomes a self-correcting re-read.
- **Status:** **fixed in this PR** — char-bigram Jaccard nearest-line hint
  (catches paraphrase drift and single-char typos alike). Test: `safety.test.ts`
  asserts the hint appears on a near-miss.

### 8. NOTE · P2 — part-selection asks the model to _verify_ MPNs it cannot verify

- **Where:** `src/commands/create.ts` stage-3 contract vs the "datasheet-
  verifiable justification" requirement.
- **Symptom:** offline/local models have no datasheet reach; UNVERIFIED is
  honest for any MPN they emit. The gate requiring ≥1 concrete MPN trades
  honesty for completability — a model that takes the flagging instruction
  literally (or doubts its memory) can never finish.
- **Suggested:** either accept "well-known jellybean MPN asserted from memory,
  flagged for human check" as satisfying the gate (status quo — prompt now
  says so), or wire a part-research/datasheet tool before requiring verified
  MPNs (the `add-part-research-tools` change exists for exactly this).
- **Status:** noted; prompt-side mitigation shipped.

### 9. DEFECT · P3 — tmp-sweep tests run the sweeper against a synthetic future clock, deleting unrelated `copperhead-*` dirs

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

### 10. NOTE · P3 — `npm run lint` does not exist (issue asks for it)

- **Where:** `package.json` scripts — only `lint:md` (markdownlint) is wired;
  there is no ESLint/oxlint script.
- **Symptom:** a contributor following the issue's "npm test + npm run lint
  pass" checklist finds `lint` missing. Same observation as PR #189's
  findings.
- **Suggested:** add a `lint` script (even `lint:md` aliased) so the documented
  gate exists.
- **Status:** noted — recurrence of the issue raised in #189.

### 11. DEFECT · P1 — recovery diagnosis aborts on the first unparseable `{...}` candidate

- **Where:** `src/agent/recovery.ts` `parseDiagnosis`.
- **Symptom:** the diagnosis prompt demands a bare JSON object, but small
  models echo the schema or emit brace-y prose first. `parseDiagnosis` brace-
  balanced only the _first_ `{`; if that candidate failed `JSON.parse` (or
  lacked a `verdict`), the function gave up and returned `abort` — so a
  fixable stage failure turned into "recovery supervisor recommends stopping
  for a human" on a formatting slip. Observed live: stage-3 refusal diagnosed
  as `abort — diagnosis was not valid JSON` even though the transcript showed
  a self-correcting trajectory (duplicate BOM row, one bad symbol).
- **Suggested:** scan every balanced top-level `{...}` candidate and take the
  first that parses _and_ carries a `verdict`; keep the abort fallback only
  when nothing parses.
- **Status:** **fixed in this PR** — candidate loop implemented; the same
  failure mode then produced `diagnosis → retry` with usable guidance on the
  very next run. Test: `recovery.test.ts` scans past brace-noise to the real
  verdict object.

### 12. DEFECT · P1 — pin dossier never queries the Footprint column, emitting false "NO INSTALLED SYMBOL" lines

- **Where:** `src/kicad/dossier.ts` `bomSymbolDossier`.
- **Symptom:** the stage-4 dossier resolves each BOM row by MPN, then Value.
  Models routinely write the intended _symbol_ into the Footprint column
  (`Switch:SW_Push`, `Diode:D_SMA`, `Battery:CR2032`) — the dossier never
  reads it, so three of seven non-passive rows rendered as "NO INSTALLED
  SYMBOL matches" inside a block explicitly labeled machine-verified. The
  model then refused with "no libraries contain the parts" — a false premise
  the dossier itself had asserted. (All three resolve: `Device:Battery_Cell`,
  `Switch:SW_Push`, `Device:D_Small`.)
- **Suggested:** add Footprint as a third candidate: resolve the full
  `Lib:Sym` id, then search the name half, then the library half — disclosed
  as `(matched by Footprint "…")`.
- **Status:** **fixed in this PR** — all three columns now queried;
  `dossier.test.ts` covers the lib_id and name-half paths.

### 13. DEFECT · P2 — OpenAI-compat provider inherits the SDK's 10-minute request timeout; slow local models die mid-turn

- **Where:** `src/agent/providers/openai.ts` — `new OpenAI(...)` with no
  `timeout`.
- **Symptom:** a compat endpoint serving a 20B model on CPU produces
  multi-thousand-token turns in >10 min; the SDK's default timeout aborts the
  request as `provider error: Request timed out.` — observed killing the
  stage-4 IR-drafting turn twice (14–15 min of zero output, then abort).
  The turn watchdog (`turnTimeoutMs`) is the intended bound; the HTTP client
  preempted it.
- **Suggested:** a `requestTimeoutMs` provider option defaulting to 60 min
  when `baseURL` is set (compat/local), leaving paid OpenAI on the SDK
  default.
- **Status:** **fixed in this PR**.

### 14. DEFECT · P1 — dossier silently omits passive refdes and never lists installed libraries; model concludes "libraries missing" and refuses

- **Where:** `src/kicad/dossier.ts` `bomSymbolDossier` (`PASSIVE_REFDES`
  skip) — observed in run `2026-09-20T10-26-44-424Z`.
- **Symptom:** R/C/L rows are dropped from the machine-verified block by
  design, but nothing says so; the model then pattern-copies BOM Footprint
  values (`Capacitor:C_0805_2012Metric`, `Resistor:R_0805_2012Metric`) into
  IR `libId`s, probes them with `symbol_pins`, gets only failures, and
  refuses with "required resistor and capacitor libraries are missing" —
  the same false-absence confabulation class as #12, one level up. It also
  has no way to enumerate which symbol libraries exist (`search` is
  repo-sandboxed; `search_symbols` needs a query term).
- **Suggested:** keep the passive filter but disclose it: a PASSIVE trailer
  naming the skipped refdes plus the canonical `Device:R`/`Device:C`/
  `Device:L` conventions (verified against the install before being
  claimed), and a final line listing the installed library names — the only
  legal lib_id namespaces.
- **Status:** **fixed in this PR** — passive disclosure + library inventory
  lines added; both still honor the `maxChars` cap.

### 15. DEFECT · P2 — assistant turns with `content: null` are rejected by Ollama's chatml backend ("400 invalid message content type: <nil>")

- **Where:** `src/agent/providers/openai.ts` request builder — assistant
  history messages serialized with `content: null`.
- **Symptom:** a reasoning-only turn (no visible text, no tool calls) is
  recorded with `content: null`; the next request is rejected by Ollama
  400s, ending the run as `provider-error` after ~3 turns of real work.
- **Suggested:** emit `content: ""` instead of `null` — equivalent
  semantics, accepted by strict chatml backends.
- **Status:** **fixed in this PR** (same commit as #13).

### 16. DEFECT · P2 — model deadlocks when a file needs a full rewrite: `write_file` refuses overwrites and minified-JSON anchors keep missing

- **Where:** `src/agent/filetools.ts` `toolWriteFile` refusal + stage-4 prompt.
- **Symptom:** the schematic IR lands as a single minified JSON line. On a
  reconcile pass the model wants to rewrite it wholesale, but write_file
  refuses existing files and edit_file's exact-match anchors keep missing
  (3–4 failures observed). Dead-end → `finish` with refuse:
  "We need to rewrite the complete intent.json" (run 2026-09-20T17-16).
- **Suggested:** the escape hatch already exists — `draft_schematic`'s
  `intent_json` arg writes the canonical file itself — but nothing tells the
  model to re-pass the corrected JSON instead of editing. Added one sentence
  to the stage-4 prompt saying exactly that.
- **Status:** **fixed in this PR** (prompt guidance); a
  write-after-read-allows-overwrite variant is the deeper alternative.

### 17. DEFECT · P3 — llama.cpp 500s on the model's own malformed tool calls, killing the whole stage

- **Where:** `src/agent/providers/openai.ts` compat path; observed twice
  (`error parsing tool call: raw='The intent_json string truncated…'` and
  `raw='{"}'`).
- **Symptom:** gpt-oss occasionally leaks prose or truncated JSON into the
  tool-call section; llama.cpp's parser then 500s the request, surfacing as
  `provider error: 500` → run failure. Sampling is stochastic — the same
  request usually produces a clean call on re-issue.
- **Suggested:** treat 5xx on compat endpoints as transient inside the
  provider stream path (bounded re-issues).
- **Status:** **fixed in this PR** — `chatStream` retries transport drops
  and 5xx up to 2 re-issues.

### 18. DEFECT · P1 — `intent_json` delivered as a parsed object is silently ignored; the draft re-runs the stale IR

- **Where:** `src/capabilities/handlers.ts` `draft_schematic` handler.
- **Symptom:** compat backends can hand the arg back as an already-parsed
  object rather than JSON text. The handler's `typeof intent_json ===
  'string'` guard then skips the write entirely — no error, no hint — and
  drafts whatever stale `schematic.intent.json` is on disk. Live evidence:
  the model sent a complete, correct IR as an object at turns 12 and 13 of
  run 2026-09-21T02-24, and the tool reported the same "25 finding(s)" both
  times because it never saw the new document.
- **Suggested:** accept both shapes — stringify non-string intent_json, then
  run the same validation/salvage path. (Schema text updated to match.)
- **Status:** **fixed in this PR** (`handlers.ts` + `draft-tools.test.ts`
  'accepts intent_json delivered as an already-parsed object').

### 19. DEFECT · P2 — the recovery supervisor confabulates content errors onto transport failures

- **Where:** `src/agent/recovery.ts` `diagnoseStageFailure`.
- **Symptom:** run 2026-09-21T01-38 ended on `provider error: terminated`
  (mid-stream socket drop). The diagnosis call's excerpt showed IR pin
  juggling, so the model "explained" the transport failure as missing
  symbol libraries ("Diode:D_SMA, Capacitator:C_0805_2012Metric… cannot be
  resolved") and aborted — even though every one of those lib_ids resolved
  on the machine and the attempt had reached 2 findings.
- **Suggested:** transport errors carry no information about the work;
  retry them deterministically (bounded by the retry budget) instead of
  asking the model to narrate them.
- **Status:** **fixed in this PR** — `diagnoseStageFailure` short-circuits
  `provider error: …` transport patterns to `retry` before calling the
  model (`recovery.test.ts` 'retries a transport-level provider error
  without a diagnosis call').

### 20. DEFECT · P1 — undici `bodyTimeout` kills long streamed compat turns that are producing reasoning but no wire bytes

- **Where:** `src/agent/providers/openai.ts` compat client construction.
- **Symptom:** llama.cpp streams deltas for visible content only; during a
  long reasoning phase the SSE body goes silent for minutes while the
  server keeps generating (observed: 4.2k chars streamed frozen ~60s+,
  server `n_gen` still climbing at 4 t/s). Undici's default 300s
  bodyTimeout then aborts the request → "provider error: Request timed
  out." → the whole stage attempt dies (runs 2026-09-20T22-03 and
  2026-09-21T01-38, both mid-schematic at ~45min wall).
- **Suggested:** pass a dispatcher with `bodyTimeout: 0` (and
  `headersTimeout: 0`) on compat clients — the SDK-level `timeout` option
  remains the real bound, and the chatStream re-issue covers genuine
  drops. `undici` added as a direct dependency.
- **Status:** **fixed in this PR** (`openai.ts` fetchOptions dispatcher).

### 21. DEFECT · P1 — the `write_file` overwrite refusal doesn't name the route the stage contract intends; the model deadlocks and refuses at the finish line

- **Where:** `src/agent/filetools.ts` `toolWriteFile` overwrite refusal;
  `src/capabilities/handlers.ts` `run_erc` zero-symbols warning.
- **Symptom:** run 2026-09-21T10-08, stage 4 attempt 2, turns 7-14
  (13:05-13:13 UTC): the intent file already existed (preserved from a
  prior attempt), so `write_file` refused with "use edit_file". The model
  then typoed a path (`.c copperhead/...` — a literal space) into
  `edit_file`, got a raw `ENOENT`, read the intent back twice, ran ERC —
  which reported **clean on an empty sheet** with only a generic "capture
  the parts" warning — and refused: _"We need to create the schematic
  intent with proper parts and nets before running ERC."_ The IR it was
  holding was complete (15 parts, 12 nets, full noConnect list) and the
  intended revision path (`draft_schematic` `intent_json`) was never
  tried. Wall: 3h04m spent to reach a refusal one tool call from done.
- **Suggested:** the refusal/warning text should name the intended tool —
  intent-file overwrites now point at `draft_schematic`'s `intent_json`,
  and the empty-sheet ERC warning names `draft_schematic` instead of
  "capture parts" when an intent may already exist.
- **Status:** **fixed in this PR** (`filetools.ts` refusal suffix,
  `handlers.ts` warning text).

### 22. DEFECT · P2 — a whitespace path typo surfaces as raw `ENOENT` with no hint at the actual mistake

- **Where:** `src/agent/filetools.ts` — `readFile` errors propagate
  unwrapped from `toolReadFile`/`toolEditFile`.
- **Symptom:** same attempt, turn ~9: `edit_file` on
  `.c copperhead/schematic.intent.json` (space after `.c`) →
  `ENOENT: no such file or directory, open '/tmp/ch-e2e-repo/.c copperhead/s…'`.
  Nothing in the error pointed at the typo; the model abandoned file edits
  entirely and went straight to refusal.
- **Suggested:** wrap ENOENT with `no such file: <path>` and flag paths
  containing whitespace (repo-relative paths almost never have spaces).
- **Status:** **fixed in this PR** (`filetools.ts` `readRepoFile`).

### 23. DEFECT · P1 — the recovery supervisor over-escalates refusals whose fix is editing an agent-authored artifact

- **Where:** `src/agent/recovery.ts` `diagnoseStageFailure`.
- **Symptom:** run 2026-09-21T14-39, stage 4 attempt 2: the agent refused
  with a self-described fix ("the intent requires explicit VDD/VSS nets for
  each U2 unit") and the supervisor diagnosed **abort** — "cannot be
  auto-resolved; human intervention needed to update the IR". But the IR
  (`schematic.intent.json`) is written by `draft_schematic`'s `intent_json`
  arg — the agent's own artifact, not a human input. Same failure shape as
  #19: the supervisor ratifies the agent's misconception instead of
  correcting it.
- **Suggested:** a refusal that names a fix to an agent-authored artifact
  (intent JSON, spec deltas, BOM) short-circuits to `retry` with the
  refusal's own summary as guidance — no LLM call, no confabulation
  surface. Retry budget still bounds loops.
- **Status:** **fixed in this PR** (`recovery.ts` second short-circuit).

### 24. DEFECT · P2 — the model emits its `finish` call as text; the loop records a stall instead of the refusal

- **Where:** `src/agent/loop.ts` tool-less-turn handling.
- **Symptom:** twice observed: the model ended with a bare
  `{"outcome":"refuse","summary":"…"}` text message (run 2026-09-21T13-21)
  and with a markdown envelope `**Outcome:** refuse / **Summary:** …`
  (run 2026-09-21T14-39, turn 31). Neither is a tool call, so the run
  counted a "stalled" failure and the supervisor lost the refusal reason —
  the difference between generic "stopped calling tools" guidance and the
  actual fix the model described.
- **Suggested:** recognize a finish payload in a tool-less text turn — a
  bare `{"outcome","summary"}` object or an `Outcome:`/`Summary:` envelope —
  and dispatch it through the real `finish` handler so gating still applies.
- **Status:** **fixed in this PR** (`loop.ts` `finishFromText`; two tests).

### 25. NOTE · P3 — `write_file` happily creates near-miss paths; a typoed `copperhead/` (no dot) littered the repo

- **Where:** `src/agent/filetools.ts` `toolWriteFile`; run
  2026-09-21T18-09 turn 6 wrote `copperhead/schematic.intent.json` (missing
  the leading dot) — a legal new file, silently accepted, while the
  canonical intent at `.copperhead/` went unread. The model then edited the
  typoed copy; the run's real intent never changed.
- **Symptom:** the sandbox is path-correct but not path-_aware_: nothing
  warns that `copperhead/x` is one edit away from `.copperhead/x`.
- **Suggested:** low priority — a Levenshtein-or-prefix check against
  existing top-level dirs ("did you mean `.copperhead/`?") would catch the
  class. Not fixed in this PR.

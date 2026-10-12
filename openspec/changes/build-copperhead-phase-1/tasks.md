# Tasks: Build copperhead Phase 1

> **Status (2026-07-18, evening): 52/61 complete.** Every deterministic capability is
> implemented and covered by the offline suite (57 tests green). The agent loop is now
> **verified live** with an OpenAI key (model `gpt-5-nano`, the only model on this key):
> AC-3.1 net rename with surgical <5% diff (AC-3.7), AC-3.4 budget refusal via compliant
> alternative, AC-3.5 repair convergence observed in run logs, AC-3.6 byte-identical rollback,
> AC-4.1 no key material in the tree. Still open: AC-3.2/AC-3.3 integration tests (not yet
> written), provider parity AC-3.10 (needs an Anthropic key), create-pipeline stages and the
> sync resolve phase (implemented, never run live), and the section 11 demo tasks.
>
> Treat an unchecked box here as "not yet observed working", not "not yet written".

## 1. Project scaffold

- [x] 1.1 Initialize package.json (Node ≥ 20, type module, bin `copperhead` → dist/cli.js), tsconfig.json, vitest config; deps: commander, execa, openai, @anthropic-ai/sdk; dev: typescript, tsx, vitest
- [x] 1.2 Add .gitignore (`.env`, `.copperhead/runs/`, dist/, node_modules/) and .env.example (OPENAI_API_KEY / ANTHROPIC_API_KEY) — must land in the first commit (AC-4.3)
- [x] 1.3 Create src/ tree per SPEC §2.1 (cli.ts, agent/, kicad/, memory/, util/) with stub modules that compile
- [x] 1.4 Build test/fixtures/: minimal known-good KiCad project (ESP32-S3-class MCU symbol, a few passives, KEY_DAH net, clean ERC/DRC) committed as text
- [x] 1.5 Verify toolchain: `npm run build` produces dist/, `copperhead --help` runs after `npm i -g .`, `kicad-cli version` detection with clear error when missing

## 2. KiCad tooling

- [x] 2.1 Implement src/kicad/cli.ts: execa wrapper for `sch erc`, `pcb drc` (`--format json --exit-code-violations`), `export svg`; version detection
- [x] 2.2 Implement src/kicad/report.ts: normalize ERC/DRC JSON into `{severity, type, description, sheet?, position?}`; unit tests against captured fixture reports
- [x] 2.3 Implement src/kicad/sexp.ts: read-only tokenizer/walker; `list_symbols` (ref, value, footprint, sheet incl. hierarchical) and `list_nets`; unit tests against the fixture

## 3. File tools and safety rails

- [x] 3.1 Implement sandboxed file tools: read_file (ranged), write_file (new files only; refuses .kicad_* overwrite), edit_file (exact unique anchored replace with actionable non-unique errors), search (ripgrep via execa)
- [x] 3.2 Implement path sandbox: resolve + reject anything escaping repo root; unit test with `../../etc/hosts` (AC-4.2)
- [x] 3.3 Implement transcript writer (.copperhead/runs/<ts>/ JSONL) with write-time secret redaction of `sk-[A-Za-z0-9_-]+`; unit test redaction (AC-4.1)
- [x] 3.4 Implement git guard: dirty-tree refusal, `--allow-dirty` with `git stash create` snapshot, restore-to-snapshot helper; unit tests (AC-3.8, AC-3.6 precondition)
- [x] 3.5 Implement human-readable run summary: write `summary.md` beside transcript.jsonl on every run end (request, change id, plan, files touched, ERC/DRC results, decisions, token usage), same redaction pass as the transcript

## 4. Agent core

- [x] 4.1 Define Provider interface + internal Msg/Turn/ToolSchema types; implement providers/openai.ts and providers/anthropic.ts with format mapping
- [x] 4.2 Implement withRetry: 429 exponential backoff ×3, then cross-provider failover when the other key exists
- [x] 4.3 Implement tools.ts registry (`{name, description, jsonSchema, handler}`) with capability-filtered composition (edit tools excluded until unlock) and dispatch
- [x] 4.4 Implement prompts.ts: system prompt with SPEC §4.3 verbatim rules, config budgets, constraint registry injection, docs-as-memory preamble
- [x] 4.5 Implement loop.ts: load docs → plan → edit → verify (ERC always, DRC if board changed) → repair (≤ maxRepairCycles) → propagate (check_drift) → rationale → commit; maxTurns budget; token usage logging; rollback + transcript path on failure
- [x] 4.7 Implement decision logging in the loop: append each non-trivial decision (date, run id, decision, rationale, affected refdes/nets/docs) to `docs/DECISIONS.md`, append-only, included in the run's commit
- [x] 4.8 Implement the sync-obligations ledger: deterministic post-tool-call hooks record obligations (KiCad edit → ERC/DRC + drift + changelog; constraint change → dual-write + affects[] revisit; decision → DECISIONS.md append); commit step refuses while any obligation is open; final ledger state written into summary.md; unit tests for each hook trigger
- [x] 4.6 Model selection precedence (flag > COPPERHEAD_MODEL > config.json > available key) with unit test

## 5. Spec gating (OpenSpec integration)

- [x] 5.1 Implement OpenSpec subprocess wrapper (init/validate/archive), mirroring the kicad-cli wrapper
- [x] 5.2 Wire plan step: agent writes openspec/changes/<id>/ with read-only tools, loop runs `openspec validate --change <id>`, unlock edit tools on pass; AUTO marker in autonomous mode; transcript records the unlock
- [x] 5.3 Implement `--interactive` y/n gate between validation and edit unlock
- [x] 5.4 Wire archive into the commit path: ERC/DRC-clean commit triggers `openspec archive <id>`
- [x] 5.5 Implement constraint registry: record_constraint tool (same-turn dual write, `affects[]`, source), load into system prompt, mechanical checks (leakage sum vs budget, forbidden pins) callable by `check`

## 6. docs-memory (`init` + drift)

- [x] 6.1 Implement memory/scaffold.ts: detect .kicad_sch/.kicad_pcb, generate docs/ (SPEC/BOM/PINOUT/SUBSYSTEMS/LAYOUT.md) with fixed table formats pre-filled from list_symbols/pin-net parse, plus .copperhead/config.json (AC-1.1–1.3)
- [x] 6.2 Implement idempotency: parsed-content hashes in config.json; re-run exits 0 unchanged; hand-edit detection refuses without `--force` listing files (AC-1.4); clear non-zero error when no .kicad_sch (AC-1.5)
- [x] 6.3 Implement memory/drift.ts: parse BOM/PINOUT tables, diff against schematic parse, report `{doc, claim, actual}` (AC-2.3)
- [x] 6.4 Scaffold `docs/DECISIONS.md` (append-only decision log header + format) and generate `.copperhead/README.md` documenting every config key, budgets semantics, constraints.json format, and runs/ layout; README regenerates on re-runs and is exempt from the `--force` hand-edit refusal
- [x] 6.5 Scaffold `docs/CHANGELOG.md` and implement per-commit changelog append (date, change id, request, files touched, verification result, newest first) wired into the loop's commit path
- [x] 6.6 Implement git pre-commit hook install at `init` (thin script calling `copperhead check`), `--no-hooks` opt-out, idempotent re-install; test that a desynced hand edit is blocked at `git commit`

## 7. `check` command

- [x] 7.1 Implement `copperhead check` (with `verify` alias): ERC + DRC + drift + `openspec validate` + mechanical constraint checks; zero LLM/network calls; non-zero exit on any violation (AC-2.1, AC-2.2)
- [x] 7.2 Implement `--json` output with stable keys (AC-2.4)
- [x] 7.3 Tests: clean fixture passes < 60 s with network guard asserting no api.* calls; broken-pin fixture fails with location; BOM-drift fixture fails naming doc/claim/actual (AC-2.5)

## 8. `do` command end-to-end

- [x] 8.1 Wire `copperhead do` CLI: global flags (--repo, --dry-run, --json), --model, --max-turns, --allow-dirty, --interactive
- [x] 8.2 Implement --dry-run: propose diff, write nothing (AC-3.9)
- [x] 8.3 Structured commit message (`copperhead: <request>` + edits/verification summary)
- [x] 8.4 Integration test AC-3.1 (net rename): propagation to docs, ERC 0, one commit, diff locality < 5% lines (AC-3.7)
- [ ] 8.5 Integration test AC-3.2 (RTC-capable pin move): strapping table consulted in transcript, schematic/PINOUT agree
- [ ] 8.6 Integration test AC-3.3 (add RGB LED): unique refdes, valid footprint, UNVERIFIED BOM row with rationale
- [x] 8.7 Integration test AC-3.4 (budget refusal): 100kΩ pullup refused citing 25 µA budget — the money demo
- [x] 8.8 Integration tests AC-3.5/3.6 (repair loop converges; rollback leaves tree byte-identical)
- [ ] 8.9 Provider parity: AC-3.1 green on both --model gpt-5 and --model claude (AC-3.10)

## 9. `create` pipeline (Mode A)

- [x] 9.1 Implement brief ingestion + stage runner: each stage a do-loop run with stage prompt and gate; stage completion inferred from repo state (resumable)
- [x] 9.2 Stage 1: seed openspec/specs/ from brief (requirements with Given/When/Then scenarios) + SPEC.md budgets with ASSUMED flags
- [x] 9.3 Stages 2–4: architecture (SUBSYSTEMS.md) → part selection (BOM.md, drift gate) → schematic sheet-by-sheet (ERC gate per sheet)
- [x] 9.4 Stage 5: first-draft layout — rule-driven placement coordinates, power/critical net routing, DRC gate, auto-written `## Draft quality` section in LAYOUT.md
- [x] 9.5 Stage 6: outputs package via kicad-cli — gerbers+drill zip (JLC/PCBWay profile), DXF/STEP, SVG renders, ordering BOM.csv from BOM.md
- [x] 9.6 Stage 7: firmware scaffold + pins.h generated from PINOUT.md; vendor toolchain build gate with explicit "not compiled here" fallback in DEVPLAN.md
- [x] 9.7 Stage 8: DEVPLAN.md (bring-up steps, test points, risk list, prototype order plan)
- [ ] 9.8 Interactive mode: spec-approval and pre-export gates re-enabled with --interactive; resumability test (kill after BOM stage, re-run continues)

## 10. `sync` command (full-state verify and resolve)

- [x] 10.1 Implement the verify phase (deterministic, no LLM): aggregate check_drift, bidirectional constraints.json vs doc/spec audit, PINOUT.md vs pins.h diff, DECISIONS/CHANGELOG coverage, and `openspec validate` into one inconsistency report with proposed resolutions
- [x] 10.2 Implement `sync --dry-run`: print the full report (doc, claim, actual, proposed resolution), write nothing (AC-7.4)
- [x] 10.3 Implement the resolve phase: spec-gated agent run seeded with the report, truth precedence (KiCad = as-built facts, specs/budgets = requirements), single commit with DECISIONS/CHANGELOG entries (AC-7.1, AC-7.2)
- [x] 10.4 Implement violation flagging: inconsistencies that imply a requirement violation are reported with both sides and the governing spec, never rewritten, exit non-zero (AC-7.3)
- [ ] 10.5 Tests: doc-drift fixture resolved then `check` clean; dual-write gap repaired both directions; violation fixture flagged not rewritten; clean repo no-op and double-run idempotence (AC-7.5)

## 11. Submission readiness

- [ ] 11.1 README quickstart (clone → npm i -g . → init/do/check on fixture) verified on a clean machine (AC-6.1)
- [ ] 11.2 Full-tree secret grep in CI/test teardown: no `sk-[A-Za-z0-9_-]{20,}` anywhere incl. .copperhead/runs/ (AC-4.1)
- [ ] 11.3 Record one full demo run (screen capture) and export the 1-minute video (AC-6.2, AC-6.3)
- [ ] 11.4 Live-verify the three pitch demos on the demo machine: AC-3.4, AC-3.2, AC-3.1 (AC-6.4)

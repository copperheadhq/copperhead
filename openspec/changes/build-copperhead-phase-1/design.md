# Design: Build copperhead Phase 1

## Context

The repo contains only `openspec/specs/SPEC.md` — the full technical specification for copperhead, a CLI agent that designs and edits real KiCad projects. Everything else is greenfield. The spec is unusually prescriptive (repo layout §2.1, tool schemas §4.2, system-prompt rules §4.3, acceptance criteria §9), so this design mostly resolves *how* to realize those requirements in TypeScript, not *what* to build.

Hard constraints from the spec:

- Node ≥ 20, TypeScript, Apache-2.0, `bin: copperhead`.
- Two invariants: (1) edit tools are structurally unavailable until an OpenSpec proposal validates; (2) no mutation is reported done until ERC/DRC passes.
- KiCad files are edited as **text** (anchored search/replace on s-expressions); parsing is read-only, for listing symbols/nets and drift checks.
- Both OpenAI and Anthropic providers must pass the same integration test.
- `check` makes zero LLM calls.

## Goals / Non-Goals

**Goals:**

- Ship the four Phase 1 commands (`create`, `init`, `do`, `check`) meeting AC-1 through AC-4 and AC-6.
- A single agent loop reused by `do` and by every `create` stage (Mode A = Mode B iterated).
- Deterministic, LLM-free `check` usable in CI.
- Demo-critical behaviors first: budget refusal (AC-3.4), constraint-aware pin choice (AC-3.2), propagating rename (AC-3.1).

**Non-Goals:**

- Phase 2 viewer (`watch`), Phase 3 integrations (CI action, simulation, KiCad plugin, part-data APIs, hosting).
- Autorouting or placement optimization; full s-expression round-trip serialization.
- `explain` command (stretch — only if time remains), Windows support, Altium/Eagle formats.

## Decisions

### D1 — Runtime & packaging: tsx for dev, tsc build to `dist/`, commander CLI

Plain `tsc` to `dist/` with `bin: { "copperhead": "dist/cli.js" }` keeps `npm i -g .` working on a clean machine (AC-6.1). No bundler — the dependency graph is small and a bundler adds failure modes on hackathon day. Commander over yargs for subcommand ergonomics and built-in help. Vitest as test runner (fast, TS-native), execa for subprocesses.

### D2 — Tool layer as data: one registry, capability-filtered per turn

Tools are defined once as `{ name, description, jsonSchema, handler }` in `src/agent/tools.ts`. The loop composes the tool list per turn from the run's *capability state*: `edit_file`/`write_file` are only included after the run's OpenSpec proposal has validated (invariant 1). This makes the spec-gate structural — the model literally cannot call an absent tool — rather than prompt-discouraged. Alternative considered: always expose tools but reject calls pre-validation; rejected because the spec explicitly requires "unavailable in the tool list."

### D3 — Provider abstraction: normalize to an internal `Turn` type

`Provider.chat(messages, tools, opts) → Turn` where `Turn` is `{ text?, toolCalls: [{id, name, args}], usage }`. Each provider file owns the mapping to/from its SDK's message and tool formats; the loop only ever sees the internal types. Provider selection: `--model` flag > `COPPERHEAD_MODEL` > config.json > first available API key. 429 handling lives in a shared `withRetry` wrapper (exponential backoff ×3, then failover to the other provider if its key exists) so both providers get identical resilience.

### D4 — KiCad edits: anchored text replace; parse only for reading

`edit_file` is an exact-match, must-be-unique string replace (same contract as this harness's Edit tool) — satisfying "surgical edits" (AC-3.7) by construction. `src/kicad/sexp.ts` is a minimal tokenizer/walker good enough to extract symbols (ref/value/footprint/sheet) and net labels; it never serializes. This avoids the classic failure of round-tripping KiCad's format (whitespace/UUID churn producing massive diffs). Trade-off: the agent must find good anchors in large files; mitigated by giving it `search` (ripgrep via execa) and `read_file` with line ranges.

### D5 — ERC/DRC: `kicad-cli` with `--format json`, one report normalizer

`run_erc`/`run_drc` shell out to `kicad-cli sch erc` / `pcb drc` with `--format json --exit-code-violations`, writing reports into the scratch dir of the run. `src/kicad/report.ts` normalizes both into `{ severity, type, description, sheet?, position?, items[] }`. The loop's repair cycle (max `maxRepairCycles`, default 5) feeds violations back verbatim; on exhaustion it restores the snapshot and exits non-zero (AC-3.6).

### D6 — Run lifecycle: git snapshot, transcript, structured commit

`do` and `repl` refuse a dirty tree unless `--allow-dirty` (whose snapshot pairs a `git stash create` object for tracked changes with a tree object for the untracked, non-ignored files the stash cannot capture, so the rollback's `git clean -fd` cannot destroy them; clean trees snapshot via the current HEAD). Every run writes a JSONL transcript to `.copperhead/runs/<timestamp>/`, with a redaction pass (`sk-[A-Za-z0-9_-]+` and generic bearer-token patterns) applied at write time, not post-hoc (AC-4.1). Success path: single `git commit` with the structured message; failure path: hard restore to snapshot, print transcript path, exit 1.

### D7 — Spec-gating: OpenSpec as subprocess, proposal-as-plan

The plan step of `do` *is* the OpenSpec proposal: the agent (with only read/search/openspec tools available) writes `openspec/changes/<id>/`, then the loop runs `openspec validate --change <id>`. On pass, the tool registry unlocks edit tools (D2); in `--interactive` mode a y/n prompt sits between validation and unlock. Archive runs in the same code path as the commit. OpenSpec is invoked via execa exactly like kicad-cli — no library coupling. If the target repo lacks `openspec/`, `init`/`create` run `openspec init` once.

### D8 — Constraint registry: same-turn dual write

`.copperhead/constraints.json` entries (`{ key: { min/max/forbidden, source, affects[] } }`) are written by a dedicated `record_constraint` tool that the agent must call whenever it writes a constraint into a doc — keeping doc and registry in the same tool turn as the spec requires. The registry is injected into every run's system prompt, and `check` mechanically validates what it can: leakage sums against current budgets, forbidden-pin usage against the parsed pinout. Geometry checks (keepouts) are best-effort Phase 1.

### D9 — Drift check: doc tables as the parseable contract

BOM.md and PINOUT.md use fixed markdown table columns (refdes | value | footprint | MPN | rationale; pin | net | function | notes). `check_drift` parses these tables and diffs them against `list_symbols`/pin-net extraction, reporting `{ doc, claim, actual }` (AC-2.3). Free-prose docs (SPEC/SUBSYSTEMS/LAYOUT) are not drift-checked mechanically in Phase 1. `init` generates the tables from the real schematic (AC-1.2/1.3) and is idempotent via content hashes stored in `.copperhead/config.json` — hand-edits detected by hash mismatch trigger the `--force` refusal (AC-1.4).

### D10 — `create` pipeline: staged `do` runs, state in the repo

Each stage (spec seed → architecture → BOM → schematic per sheet → layout draft → exports → firmware → DEVPLAN) is a `do`-loop invocation with a stage prompt and stage-specific completion gate (ERC per sheet, DRC for layout, export success, firmware build). Stage completion is inferred from the repo itself (which docs/files exist and pass their gates), making `create` resumable with no separate state file. Firmware verification = vendor toolchain build exits 0 (ESP-IDF/Arduino CLI detected per MCU choice); if no toolchain is present, the stage emits the scaffold and marks DEVPLAN.md with an explicit "not compiled here" flag rather than failing the run (run-to-completion guarantee).

### D11 — Test strategy: fixture-first, LLM tests behind a flag

`test/fixtures/` gets a tiny known-good KiCad project (few symbols, one MCU-ish part, clean ERC/DRC) committed as text. Unit tests cover sexp parsing, report normalization, drift diffing, path sandboxing, and redaction with no network. Integration tests that exercise the live loop (AC-3.x) run only when an API key env var is present, and each asserts on the transcript (e.g. AC-3.2 requires evidence the strapping table was consulted). AC-2.1's "no LLM calls" is asserted by running `check` with a poisoned `HTTPS_PROXY`/no-network guard.

### D12 — User-viewable memory: no black-box state

Everything the agent remembers or decides has a human-readable surface, in three layers:

- **`docs/DECISIONS.md`** — append-only decision log in the user's repo, scaffolded by `init`. Every run appends one entry per non-trivial decision: date, run id, the decision, the one-line rationale, and what it affects (refdes/nets/docs). This complements the in-place rationale lines (§4.3): the doc rationale answers "why is this here?", the log answers "what has the agent decided over time, in order?". Append-only so history is never rewritten; the loop's commit includes it.
- **`.copperhead/runs/<ts>/summary.md`** — written beside `transcript.jsonl` at the end of every run: the request, the OpenSpec change id, the plan, files touched, ERC/DRC results, decisions made (mirroring the DECISIONS.md entries), and token usage. A human can audit a run without reading JSONL.
- **`.copperhead/README.md`** — generated at `init`. JSON carries no comments, so config.json stays machine-clean and the README carries the commentary: every config key explained, budget semantics, what `constraints.json` is and how `affects` works, and the runs/ directory layout. Regenerated on `init` re-runs (it is generated documentation, not user state — excluded from the hand-edit refusal).

Alternative considered: JSON5/YAML config for inline comments — rejected because the spec fixes `.copperhead/config.json` and a sidecar README keeps tooling simple.

### D13 — Sync hooks: an obligations ledger the commit gate enforces

Staleness is prevented mechanically, not by prompting. The loop maintains an in-run **obligations ledger**; deterministic post-tool-call hooks (code, not LLM) append obligations, and the commit step refuses to run while any obligation is open:

| Event (hook trigger) | Obligation(s) recorded |
|---|---|
| `.kicad_sch` / `.kicad_pcb` edited | ERC (and DRC for board) must pass; `check_drift` must run clean; changelog entry pending |
| Constraint stated/assumed/discovered | Dual write to `constraints.json` verified; every item in its `affects[]` list marked for revisit and explicitly resolved (changed or "no change needed" with reason) |
| Any doc value edited | Drift re-check; registry cross-check if the value backs a constraint |
| Non-trivial decision made | `docs/DECISIONS.md` append pending |
| Run reaching commit | `docs/CHANGELOG.md` entry (date, change id, request, files touched, verification result) pending |

The ledger state is written into `summary.md`, so an aborted run shows exactly which sync obligations were left open. This turns "keep everything in sync" from an instruction the model might forget into a gate the run cannot pass without satisfying — the same philosophy as ERC/DRC (nothing is done until the tools agree).

For human edits outside the agent: `init` installs a git pre-commit hook that runs `copperhead check` (ERC + DRC + drift + openspec validate + mechanical constraints), so a hand edit that desyncs docs fails at commit time too. Opt-out via `init --no-hooks`; the hook script is a two-liner calling the installed CLI, never a copy of logic. Copperhead's own commits bypass this hook (using `--no-verify`) because they have already passed the identical run-level verification gates inside the loop.

`docs/CHANGELOG.md` is the design changelog: append-only, one entry per committed run, newest first — the narrative "what changed and why" companion to git history, written for hardware reviewers who won't read diffs of s-expressions.

### D14 — `copperhead sync`: verify everything, resolve what's safe, flag what isn't

`check` detects; `sync` detects **and resolves**. It runs in two phases:

1. **Verify (deterministic, no LLM)** — aggregate every consistency check into one report: doc tables vs parsed schematic (`check_drift`), constraints.json vs doc/spec mentions in both directions (dual-write audit), PINOUT.md vs generated pins.h, DECISIONS/CHANGELOG coverage of past commits, `openspec validate`. `--dry-run` stops here and prints the report with proposed resolutions.
2. **Resolve (spec-gated agent run)** — one `do`-loop run whose proposal *is* the inconsistency report; the usual gates apply (proposal validates → edits unlock → ERC/DRC → obligations ledger → single commit + changelog/decision entries).

Resolution is governed by a **truth-precedence rule**: KiCad files are ground truth for *as-built facts* (a doc claiming R7 is 10k when the schematic says 100k → doc gets fixed); openspec specs and SPEC.md budgets are ground truth for *requirements*. When the two collide — the as-built state violates a requirement — `sync` must not make the report green by rewriting either side; it flags the violation with both sides and the governing spec, and exits non-zero. Silent resolution of a violation would be the docs-drift failure mode reborn with tooling assistance.

Idempotence falls out of the design: phase 2 only runs when phase 1 finds resolvable inconsistencies, so a second `sync` is a no-op (AC-7.5). Alternative considered: folding resolution into `check --fix` — rejected because `check` is contractually LLM-free and CI-safe; mixing modes would blur that guarantee.

## Risks / Trade-offs

- [kicad-cli version drift — JSON report shape differs across KiCad 8/9] → Pin a minimum version, detect via `kicad-cli version` at startup, and keep the report normalizer tolerant of missing fields.
- [LLM anchored edits fail on huge `.kicad_sch` files] → `search` + ranged `read_file` keep context small; `edit_file` uniqueness errors return actionable messages ("anchor matched 3 times") so the model can widen the anchor.
- [Provider parity slips (AC-3.10) because prompts tuned on one model] → CI-style parity test on the fixture for both providers; keep provider-specific logic confined to the mapping layer.
- [Hackathon time — `create` pipeline is large] → Build order follows the spec's priority: `do` + gating + check first (AC-3.4/3.2/3.1), `init`, `check`, then `create`; every stage of `create` reuses the already-tested loop.
- [OpenSpec CLI availability in target repos] → Declare it a runtime dependency of copperhead itself so the subprocess always resolves via the installed package.
- [Idempotency hashes fragile if user reformats docs] → Hash only parsed table content, not raw bytes.

## Migration Plan

Greenfield — no migration. First commit must already contain `.gitignore` with `.env` and `.copperhead/runs/` (AC-4.3). Rollback story within a run is the git snapshot (D6).

## Open Questions

- Which exact GPT-5 / Claude model IDs to default to (depends on hackathon key entitlements — resolve at implementation with a config default that's easy to change).
- Whether the fixture is a trimmed copy of the open-telegraph repo or a purpose-built minimal project (leaning minimal purpose-built for test speed).
- How much of the layout first-draft (coordinate writing into `.kicad_pcb`) lands in Phase 1 vs. being labeled Draft-quality with placement only — decide after the schematic path is solid.

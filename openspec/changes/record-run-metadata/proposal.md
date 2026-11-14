# Record full run metadata and improve output logs

## Why

A run's context is mostly invisible today: the `run-start` transcript event records only `request`/`model`/`provider` (`src/agent/loop.ts:168`), `summary.md` shows request/outcome/change/tokens, and the live CLI shows nothing about the environment at all. Every debugging session so far (issues #19, #21 in copperhead-test) began by reverse-engineering which copperhead build ran, what config was resolved, and what the repo looked like at run start — from transcripts, `which copperhead`, and `git status`. Runs are long, non-deterministic, and cost real tokens; a cheap deterministic metadata header makes each run self-describing and comparable across model/config changes. This implements GitHub issue #22 (copperheadhq/copperhead).

## What Changes

- Collect a structured **run metadata block** before the first agent turn: tool versions (copperhead version + install path, `kicad-cli`, Node, platform), model/provider plus the **selection source** that won (flag > `COPPERHEAD_MODEL` > config > available-key fallback), run identity (run id, ISO timestamp, command, stage name + pipeline position, interactive vs autonomous, brief path + content hash for `create`), the **resolved** config snapshot (`schematic`/`board`/`docs`/`maxTurns`/`maxRepairCycles`/`budgets`), and repo state (commit, branch, dirty status + uncommitted-file count, pre-commit hook installed, open-constraint and prior-run counts).
- Write that block to **three surfaces**: the `run-start` event in `transcript.jsonl` (complete, machine-readable), a new `## Environment` section in `summary.md`, and a one/two-line header in live CLI output (at minimum: version, model/provider + source, stage, turn budget).
- Record **post-run addenda** at finish on the same three surfaces: tokens in/out with per-turn breakdown, turns used vs budget, repair cycles used vs budget, wall-clock duration, and a machine-readable **exit path** (`done` / `refused` / `turn-budget-exhausted` / `repair-cycles-exhausted` / `commit-failed` / `provider-error`). Commit failures must land in `summary.md` as an outcome instead of surfacing only as a raw stack trace.
- Improve **live CLI output** during the loop: per-turn progress carries a turn counter against the budget plus cumulative token usage (e.g. `[turn 7/40 · 12.3k in / 4.1k out]`), tool-call result lines stay one line each, and the run ends with a clear outcome line (outcome, verification, commit, duration, tokens).
- Make the live output **interactive on a TTY**, taking inspiration from the Claude Code CLI: a persistent status line at the bottom of the terminal, updated in place (spinner while waiting on the provider, elapsed time, turn counter, cumulative tokens), with assistant text and tool results scrolling above it. When stdout is not a TTY (CI, pipes), or `--json` is set, or the new global `--plain` flag is passed, output stays plain line-oriented with no ANSI escape codes.
- Metadata collection is deterministic and LLM-free; a metadata probe that fails (e.g. `git` metadata in a weird state) degrades to `null` fields rather than failing the run.

## Capabilities

### New Capabilities

- `run-observability`: run metadata capture at run start (transcript event, summary `## Environment`, CLI header), post-run addenda (usage/budget/duration/exit path), and live progress output for agent-loop runs — interactive status line on a TTY, plain lines otherwise.

### Modified Capabilities

<!-- none: this change only adds new requirements; no existing WHEN/THEN scenario in the phase-1 delta specs or SPEC.md changes behavior. agent-core's existing transcript/summary requirements are extended, not altered. -->

## Impact

- `src/agent/loop.ts` — build the metadata block before turn 1, enrich the `run-start` event, emit the CLI header, track per-turn usage and wall-clock, thread the exit path into every terminal branch (including commit failure, currently an unhandled throw).
- `src/agent/transcript.ts` — `RunSummaryData` gains environment + addenda fields; `writeSummary` renders `## Environment` and run-stats sections.
- `src/config.ts` — `resolveModel` must report **which source** won (return value gains the source, or a parallel resolver); callers updated.
- `src/cli.ts` — pass version/command/selection-source into the loop; `do`/`create`/`sync` call sites updated.
- `src/commands/create.ts` — pass stage name + position (`k/N`) and brief path/hash per stage run.
- `src/commands/sync.ts` — resolve phase passes `command: sync`.
- `src/util/git.ts` — new read-only probes (branch, uncommitted count, hook presence) or reuse of existing ones.
- New `src/agent/render.ts` — progress renderer behind the existing `log` seam: interactive status-line mode (TTY) and plain-line mode (non-TTY/`--json`); hand-rolled ANSI, no new dependencies.
- Tests: unit tests for metadata collection (offline, no LLM), summary rendering, and redaction of the new fields; existing loop tests updated for the enriched `run-start` shape.
- `openspec/specs/SPEC.md` — new **AC-8 · Run observability** acceptance-criteria block (AC-8.1 … AC-8.10), mapping 1:1 onto this change's delta-spec scenarios.
- No new dependencies; no breaking CLI changes (`--json` output gains fields, existing fields unchanged).

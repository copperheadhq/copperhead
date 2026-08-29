---
title: CLI reference
description: Every copperhead command, flag, and exit code.
sidebar:
  order: 1
---

```text
copperhead [global options] [<command>]
```

With no subcommand, `copperhead` starts the interactive agent shell. Every command probes `kicad-cli` before doing anything and exits 1 if it cannot be found. Resolution order: `COPPERHEAD_KICAD_CLI` when set, then `kicad-cli` on your `PATH`, then the macOS KiCad.app bundle locations. Setting `COPPERHEAD_KICAD_CLI` to a path that does not exist is an error naming that path, not a silent fall back to `PATH`. A `.env` in the working directory is loaded before any command resolves a model or a provider; a real environment variable always beats the file.

## Commands at a glance

| Command | Flow | LLM? | What it does |
| --- | --- | --- | --- |
| `repl` (default) | [Edit an existing board](/workflows/edit-existing-board/) | Yes | Interactive agent shell; each prompt is one `do`-equivalent run. |
| `demo` | [Simple demo](/getting-started/demo/) | Tour no / pipeline yes | Tour of what copperhead does, or run the USB-C breakout create pipeline. |
| `init` | Setup | No | Scaffolds `docs/` from an existing schematic. |
| `check` (`verify`) | Either | No | ERC, DRC, drift, constraints, spec validation. CI-safe. |
| `do` | [Edit an existing board](/workflows/edit-existing-board/) | Yes | One change: propose, edit, verify, propagate, commit. |
| `create` | [Design from a brief](/workflows/create-from-brief/) | Yes | Full pipeline from a markdown brief to an output package. |
| `sync` | Either | Verify phase no, resolve phase yes | Reconciles docs, files, and constraints. |
| `draft` | [Design from a brief](/workflows/create-from-brief/) | No | Deterministically draws the schematic from `schematic.intent.json`. |
| `score` | Either | No | Quantitative legibility score for the schematic (0-100, advisory). |

## Global options

| Option | Description |
| --- | --- |
| `--repo <path>` | Target repository. Defaults to the current directory. |
| `--json` | Machine-readable output on stdout. |
| `-V, --version` | Print the version. |

Global options go before the subcommand: `copperhead --json check`.

## `copperhead` / `copperhead repl`

Interactive agent shell (default when no command is given). On a TTY it takes over the full window (alternate screen, restored on exit): banner on top, input pinned at the bottom, each line runs the same gated loop as `copperhead do`, then returns to the prompt. Ctrl+C twice exits; PgUp/PgDn scroll the session history; Esc dismisses the slash menu; a pasted multi-line request arrives as one request instead of submitting at its first newline. Every session mirrors its log to `.copperhead/runs/repl-<timestamp>.log` (ANSI stripped, secrets redacted with the same write-time redactor as the run transcripts).

```bash
copperhead
copperhead "add reverse-polarity protection on VIN"   # seed request, then stay in the shell
copperhead repl --model claude-code
```

| Option | Description |
| --- | --- |
| `--model <model>` | Model / provider selection (same as `do`). When no model is configured anywhere (flag, `COPPERHEAD_MODEL`, config, `.env` API keys), the shell offers an interactive picker instead of refusing to start. |
| `--max-turns <n>` | Turn budget per request. |
| `--allow-dirty` | Permit a dirty working tree, same meaning and same default (off) as on `do`. |
| `--interactive` | Pause for approval after each proposal validates. |

Slash commands inside the shell: `/help`, `/demo`, `/examples`, `/status`, `/check`, `/parts`, `/nets`, `/bom`, `/sync`, `/drift`, `/constraints`, `/openspec`, `/config`, `/git`, `/runs`, `/last`, `/model`, `/version`, `/clear`, `/quit` (`/exit`, `/q`). Type `/` to see live filtered suggestions immediately; ↑/↓ + Enter picks one, Tab completes. `/model` opens an arrow-key picker and switches the session model in place. Requires a TTY (or a seed request for a one-shot non-TTY run). `--json` is refused; use `copperhead do … --json` instead.

## `copperhead demo`

Tour of what the agent does, or an end-to-end create pipeline against the packaged USB-C power breakout brief (same as `npm run demo:simple`).

```bash
copperhead demo --tour                 # overview only (no LLM)
copperhead demo --model cursor         # scaffold + create pipeline
copperhead demo --dir /tmp/my-demo     # custom demo repo path
```

| Option | Description |
| --- | --- |
| `--tour` | Print the overview and exit. Honours the global `--json`, which emits `{ "tour": [...lines] }`. |
| `--model <model>` | Model for the create pipeline. |
| `--interactive` | Re-enable human gates during create. |
| `--dir <path>` | Demo repo directory. Default `demo-runs/usb-c-breakout` (or `COPPERHEAD_DEMO_DIR`). |

## `copperhead init`

Scaffolds design docs from an existing schematic. Idempotent.

```bash
copperhead init [--path <dir>] [--force] [--no-hooks]
```

| Option | Description |
| --- | --- |
| `--path <dir>` | Where to look for KiCad files. Default `.`. |
| `--force` | Overwrite generated docs that have been hand-edited. |
| `--no-hooks` | Skip installing the git pre-commit hook. |

Reports each file as `created`, `unchanged`, or `REFUSED`. Exits 1 if anything was refused, 0 otherwise.

## `copperhead do`

The core loop: propose, edit, verify, propagate, commit.

```bash
copperhead do "<change request>" [options]
```

| Option | Description |
| --- | --- |
| `--model <model>` | `codex`, `cursor`, `gpt-5`, `claude`, `claude-code`, `vertex`, or a provider-specific model id. Saved-login providers: `codex` (Codex CLI), `cursor` (Cursor Agent CLI), `claude-code` (Claude Code). `vertex` runs Claude via Google Cloud Vertex AI (ADC + a GCP project, no API key). |
| `--max-turns <n>` | Turn budget for this run. Overrides `maxTurns` from config. |
| `--allow-dirty` | Permit a dirty working tree. The snapshot keeps tracked changes as a `git stash create` object and untracked files as a tree object, so a rollback restores both. |
| `--dry-run` | Propose the diff and write nothing. |
| `--interactive` | Pause for approval once the proposal validates. |

Exits 1 if the run ends in failure, 0 otherwise.

## `copperhead check`

Alias: `copperhead verify`.

```bash
copperhead check
```

Runs ERC, DRC, doc-drift detection, constraint checks, and OpenSpec validation. Makes **no LLM calls and no network requests**, which is a contract, not a tendency: this is what makes it safe to run in CI and in a pre-commit hook.

ERC and DRC are skipped when no schematic or board is configured, rather than failing.

| Exit code | Meaning |
| --- | --- |
| `0` | Everything agrees. |
| `1` | At least one check failed, or `kicad-cli` is missing. |

With `--json`, prints a result object with `ok` plus per-check detail for `erc`, `drc`, `drift`, `openspec`, `constraints`, and `legibility` (findings, counts, skipped and disabled families, and the advisory `score`). Legibility findings never affect the exit code.

## `copperhead draft schematic`

```bash
copperhead draft schematic
copperhead draft schematic --intent hardware/schematic.intent.json
```

Regenerates the configured schematic deterministically from the netlist-intent IR. The verb takes the artifact as a noun (`draft pcb` is reserved for layout drafting), so `draft` alone never has to guess what it applies to: parts, nets, groups, and no-connects in; placement, wires, labels, power symbols, and captioned group boxes out. Same intent, same bytes, every run. Makes no LLM calls and no network requests. See [How schematics are drafted](/reference/schematic-drafting/).

| Exit code | Meaning |
| --- | --- |
| `0` | Drafted and written (also writes the vendored `sym-lib-cache/`, `sym-lib-table`, and a minimal `.kicad_pro` when absent). |
| `1` | Intent validation failed; the numbered findings are printed and the previous schematic is untouched. |

## `copperhead score schematic`

```bash
copperhead score schematic
```

Prints the quantitative legibility score: a 0-100 composite with the per-metric breakdown (crossings, bends, wire length, alignment, spacing uniformity, symmetry, balance, and more). Error-severity legibility findings cap the composite. Advisory by design: the exit code never depends on the score. Makes no LLM calls and no network requests.

## `copperhead doctor`

```bash
copperhead doctor [--model <model>]
```

Environment preflight: checks whether this machine can actually run a copperhead command, **before** you start one. Unlike `check`, it looks at the model provider, the one thing `check` cannot, since `check` is contractually LLM-free. Makes **no LLM calls and no network requests**; the credential check is presence-only (it verifies a required API key is set, not that it authenticates). If a compat endpoint or key is actually wrong, the real run surfaces that directly.

Checks, in order:

- **node** — at least the version copperhead requires.
- **kicad-cli** — present on PATH (a missing binary is reported, not thrown).
- **git** — present on PATH (copperhead snapshots and commits its work).
- **provider** — resolves the model the same way a run does (`--model` > `COPPERHEAD_MODEL` > config > available key) and checks its credential. Saved-login providers (`codex`, `cursor`, `claude-code`) need no key and report `info`. For `compat:<id>` it checks the variable named by `apiKeyEnv`; a local endpoint needs no key. For `vertex` it reports the resolved GCP project and region and whether an ADC source is discoverable on disk (`GOOGLE_APPLICATION_CREDENTIALS`, the gcloud ADC file, or a metadata-server environment) — presence only, no token is minted and Model Garden enablement is not checked; the privacy line is `info` (your project's Google Cloud terms govern it), not the Gemini free-tier `warn`.
- **privacy** — `compat` only. `[warn]` when the endpoint's host is documented as training on submitted prompts; `[info]` naming the host when a remote endpoint has no known policy on record. Neither ever fails the check. A true loopback endpoint (`localhost`/`127.0.0.1`/`::1`) skips this line entirely; a `.local`/LAN host does not, since that traffic still leaves the machine.
- **project** — informational: whether `.copperhead/config.json` exists and what it wires. Never blocks.

| Option | Description |
| --- | --- |
| `--model <model>` | Check the credential for this model instead of the resolved default. |

| Exit code | Meaning |
| --- | --- |
| `0` | Ready — no critical check failed. `[warn]` and `[info]` do not block. |
| `1` | Not ready — a `[FAIL]` item needs fixing. |

With `--json`, prints `{ ok, checks: [{ name, status, detail, hint? }] }`.

## `copperhead sync`

Verifies the whole design state and resolves drift. Two phases: a deterministic verify phase, then an LLM resolve phase.

```bash
copperhead sync [--model <model>] [--dry-run]
```

| Option | Description |
| --- | --- |
| `--model <model>` | Model for the resolve phase. |
| `--dry-run` | Print the inconsistency report and write nothing. |

| Exit code | Meaning |
| --- | --- |
| `0` | Clean, or drift resolved successfully. |
| `1` | The resolve phase failed. |
| `2` | Requirement violations found. |

Exit code 2 is the important one. A requirement violation means the as-built design contradicts a stated requirement, and copperhead will **never** auto-resolve that: the fix is an engineering decision. Drift, where the docs disagree with the files, is resolvable and gets resolved.

## `copperhead create`

The full pipeline from a product brief to the output package.

```bash
copperhead create --brief brief.md [--model <model>] [--interactive]
```

| Option | Description |
| --- | --- |
| `--brief <file>` | **Required.** The product brief, in markdown. |
| `--model <model>` | `codex`, `cursor`, `gpt-5`, `claude`, `claude-code` (saved-login; no model API key for those three), or `vertex` (Google ADC, no model API key). |
| `--interactive` | Re-enable the human gates: spec approval, and a pause before export. |

Exits 1 if any stage fails to complete, 0 when the pipeline finishes.

### Pipeline stages

Each stage is a full `do` loop with its own prompt and gate. Stage completion is inferred from repo state, so the pipeline is resumable: rerun the same command after a failure and it skips what is done and resumes at the first incomplete stage.

| # | Stage | Produces |
| --- | --- | --- |
| 1 | `spec` | `docs/SPEC.md`, plus every budget recorded as a constraint |
| 2 | `architecture` | `docs/SUBSYSTEMS.md` |
| 3 | `parts` | `docs/BOM.md`, MPNs flagged `UNVERIFIED` |
| 4 | `schematic` | The `.kicad_sch`, ERC clean after each sheet |
| 5 | `layout` | Draft placement and critical routing, DRC clean, plus a `## Draft quality` section in `LAYOUT.md` |
| 6 | `outputs` | `outputs/`: gerbers, drill, DXF, STEP, SVG, `BOM.csv` |
| 7 | `firmware` | `firmware/` scaffold, `pins.h` generated from `PINOUT.md` |
| 8 | `devplan` | `docs/DEVPLAN.md` |

Stages build on each other's uncommitted state, so `create` runs them as if `--allow-dirty` were set.

## Repo scripts

These are npm scripts in a copperhead checkout, not installed CLI commands.

| Script | What it does |
| --- | --- |
| `npm run demo:simple` | Runs the create pipeline against `examples/simple/usb-c-breakout.md` in `demo-runs/usb-c-breakout/`. See [Simple demo](/getting-started/demo/). |
| `npm run docs:dev` | Serves this documentation locally. |
| `npm run docs:build` | Builds the documentation site. |
| `npm test` | Runs the vitest suite. LLM-touching tests skip unless their provider is explicitly configured. |
| `npm run typecheck` | Type-checks without emitting. |
| `npm run build` | Compiles to `dist/`. |

Pass `create` flags through after `--`, for example `npm run demo:simple -- --model claude`. Override the target directory with `COPPERHEAD_DEMO_DIR`.

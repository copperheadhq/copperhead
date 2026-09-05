# copperhead — Technical Specification

**Cursor for circuit boards.** An AI agent that designs, documents, and validates real PCBs from a prompt, working directly on existing KiCad repositories.

License: Apache-2.0 · Runtime: Node.js ≥ 20 · Language: TypeScript

**copperhead is open source.** The entire tool — agent core, prompts, tools, viewer — is public under Apache-2.0, developed in the open on GitHub with public issues and PRs. It builds exclusively on an open stack (KiCad, kicad-cli, OpenSpec) and produces open, inspectable artifacts: every design decision, constraint, and rationale it writes is plain markdown and JSON in the user's own repo — no proprietary formats, no lock-in, no black box. This is a Chouhan Industries project: the same commitment that puts every hardware schematic in public applies to the tool that designs them. Open source is also the distribution strategy — hardware engineers trust what they can inspect. (Commercial layer, later: hosted agent for private repos; the open core stays complete and usable forever.)

---

## 1. Product definition

### 1.1 What it is

An AI product-development agent for hardware: from a product brief to manufacturable files, firmware, and a build plan. Two modes:

**Mode A — Designer (`copperhead create`).** Input: a product description, requirements, and constraints in natural language. The agent runs the full design pipeline: spec → architecture → part selection → schematic → layout intent → verification → output package.

**Mode B — Co-designer (`copperhead do`).** Operates on an existing KiCad repository the way a coding agent operates on a codebase (the core loop, §4). Mode A is Mode B run repeatedly against a growing repo — same loop, same tools, same verification.

The agent:

- Reads and edits real `.kicad_sch` and `.kicad_pcb` files (s-expression text format)
- Maintains a set of markdown design docs ("docs-as-memory") that describe the design's intent, constraints, and rationale
- Propagates any change across every artifact that references it (schematic, BOM, pinout, docs)
- Verifies its own work by running `kicad-cli` ERC/DRC and iterating until checks pass
- Records a one-line rationale next to every decision so future changes don't silently undo past reasoning

### 1.2 What it is not

- Not an autorouter (Quilter/DeepPCB territory) — routing stays human or delegated
- Not a new editor (Flux territory) — no walled garden; the user's KiCad install remains the editor
- Not the engineer of record — human signs off; the agent must never claim a design is fab-ready beyond "ERC/DRC clean"

### 1.3 Core invariants

1. **Nothing starts without a spec.** The agent cannot touch a KiCad file until a validated OpenSpec proposal exists for the change (`openspec validate --change <id>` passes). The edit tools (`edit_file`, `write_file`) are hard-locked — not prompt-discouraged, but unavailable in the tool list — until the proposal validates. Every edit is therefore traceable to a documented intent.
2. **Nothing is "done" until the tools agree.** Every mutation of a KiCad file must be followed by an ERC (schematic) or DRC (board) run before the agent reports success. If violations exist, the agent reads the report and fixes them or explains why it cannot.

Spec-gated in, verification-gated out: the design can't drift from its requirements, because drift is a build failure.

---

## 2. Architecture

```
┌────────────┐   prompt    ┌─────────────────────────────┐
│  CLI (cmd)  ├────────────►│        Agent core           │
└────────────┘             │  provider-agnostic LLM loop │
                           │ (OpenAI / Claude / Codex)  │
                           └──────┬──────────────────────┘
                                  │ tool calls
              ┌───────────────────┼───────────────────────┐
              ▼                   ▼                       ▼
      ┌──────────────┐   ┌──────────────┐        ┌───────────────┐
      │  File tools  │   │ KiCad tools  │        │  Memory tools │
      │ read/write/  │   │ erc / drc /  │        │ design docs   │
      │ edit/search  │   │ export-svg   │        │ load/update   │
      └──────┬───────┘   └──────┬───────┘        └──────┬────────┘
             ▼                  ▼                        ▼
        .kicad_sch /       kicad-cli               docs/*.md
        .kicad_pcb         (subprocess)            BOM, pinout…
```

### 2.1 Repo layout (this project)

```
copperhead/
├── src/
│   ├── cli.ts              # entry: commander-based CLI
│   ├── agent/
│   │   ├── loop.ts         # tool-use loop, turn budget, retry
│   │   ├── providers/
│   │   │   ├── openai.ts   # GPT-5 via OpenAI SDK (tool calling)
│   │   │   ├── anthropic.ts# Claude via Anthropic SDK
│   │   │   └── codex.ts    # local Codex CLI via official SDK + saved login
│   │   ├── prompts.ts      # system prompt + task templates
│   │   └── tools.ts        # tool schemas + dispatch
│   ├── kicad/
│   │   ├── cli.ts          # kicad-cli wrapper (erc, drc, export svg)
│   │   ├── sexp.ts         # minimal s-expression reader (validation only)
│   │   ├── report.ts       # ERC/DRC .rpt / JSON parser → structured violations
│   │   ├── draft/          # deterministic drafting engine: IR → placement → routing → emission
│   │   ├── legibility.ts   # drawing-quality checker (read-only, no subprocess)
│   │   └── score.ts        # quantitative sheet score: metrics, weights, composite
│   ├── memory/
│   │   ├── scaffold.ts     # `init`: generate docs skeleton from schematic
│   │   └── drift.ts        # doc-vs-schematic consistency checker
│   ├── viewer/             # Phase 2
│   │   ├── server.ts       # express + ws, serves live board view
│   │   └── watch.ts        # chokidar watcher → re-export SVG → ws push
│   └── util/
├── test/
│   └── fixtures/           # tiny known-good KiCad project for tests
├── docs/                   # this spec, architecture notes
├── package.json            # bin: { "copperhead": "dist/cli.js" }
├── tsconfig.json
├── .env.example            # OPENAI_API_KEY= / ANTHROPIC_API_KEY= / CLAUDE_CODE_OAUTH_TOKEN=
└── LICENSE                 # Apache-2.0
```

### 2.2 Target repo layout (user's hardware project)

`copperhead init` establishes/expects this convention:

```
their-board/
├── hardware/
│   ├── <name>.kicad_pro
│   ├── <name>.kicad_sch    # possibly hierarchical, multiple sheets
│   └── <name>.kicad_pcb
├── docs/
│   ├── SPEC.md             # what the device is; top-level constraints & budgets
│   ├── BOM.md              # every part: refdes, MPN, value, package, WHY chosen
│   ├── PINOUT.md           # MCU pin assignment table + strapping/RTC notes
│   ├── SUBSYSTEMS.md       # per-sheet values & reasoning (regulator, charger…)
│   ├── BRIEF.sha256        # originating brief path + SHA-256; created on first successful spec-seed run, preserved thereafter
│   └── LAYOUT.md           # placement/routing intent: keepouts, pours, ESD placement
└── .copperhead/
    ├── config.json         # paths, model, budgets (see §5)
    └── runs/               # transcript of each `do` run (audit trail)
```

---

## 2.5 End-to-end I/O contract

### Inputs (Mode A)

```
copperhead create --brief brief.md
```

`brief.md` — the product brief, free-form markdown:

- **What it is:** "a pocket-size Morse key that types into any device as a Bluetooth keyboard"
- **Requirements:** features, interfaces (USB-C, BLE), user interactions
- **Constraints:** power budget, size envelope, unit cost target, battery life, cert targets
- **Preferences:** MCU family, connector types, no-go parts, assembly method (hand-solder vs SMT fab)

Anything unstated → the agent proposes defaults in SPEC.md and flags them `ASSUMED` for review. Ambiguity resolution is interactive: the agent asks up to N clarifying questions before starting (configurable, 0 for demo mode).

### Outputs (the deliverable package, `outputs/`)

| Artifact | Format | Produced by |
|---|---|---|
| Design docs | SPEC/BOM/PINOUT/SUBSYSTEMS/LAYOUT.md | agent (§2.2) |
| Schematic | .kicad_sch | agent edits, ERC-clean |
| Board | .kicad_pcb | agent edits, DRC-clean |
| **Gerbers + drill** | .zip (per JLC/PCBWay profile) | `kicad-cli pcb export gerbers/drill` |
| **Board outline / enclosure ref** | .dxf, .step | `kicad-cli pcb export dxf/step` |
| **Renders** | .svg (sch + pcb), 3D .png | `kicad-cli export svg`, pcb render |
| **BOM for ordering** | .csv (refdes, MPN, qty, vendor links) | generated from BOM.md |
| **Firmware scaffold** | src/ (per MCU HAL: ESP-IDF / Zephyr / Arduino) | agent, compiles clean |
| **Pin map header** | pins.h — generated from PINOUT.md, single source of truth | drift-checked |
| **Dev plan** | DEVPLAN.md: bring-up steps, test points, what to meter first, risk list, prototype order plan | agent |

Firmware scope: scaffold + pin definitions + driver stubs + one working happy-path (e.g. key press → BLE HID report). "Compiles clean against the vendor toolchain" is the verification gate — same philosophy as ERC/DRC: nothing is done until the toolchain agrees.

### The pipeline (Mode A internally)

**Run-to-completion guarantee:** once `create` starts, it always finishes with the complete output package. Gates are *quality checks the agent must satisfy*, not stops that wait for a human. By default the pipeline is fully autonomous: unstated decisions get `ASSUMED` flags, imperfect layout gets the `Draft quality` label, and the run ends with gerbers, firmware, renders, and DEVPLAN.md on disk — an end product, reviewable as a whole. `--interactive` turns the two human gates (spec approval, pre-export review) back on for users who want them.

```
brief.md
  → SPEC.md (budgets, ASSUMED flags)          [gate: spec is self-consistent]
  → architecture (block diagram in SUBSYSTEMS.md)
  → part selection (BOM.md with rationale)     [gate: check_drift]
  → schematic, sheet by sheet                  [gate: ERC after every sheet]
  → first-draft layout (see below)             [gate: DRC]
  → outputs package                            [gate: all exports succeed]
  → firmware scaffold                          [gate: build passes]
  → DEVPLAN.md
```

Each stage is a `do`-loop run with a stage-specific prompt. State lives in the repo (docs + files), so `create` is resumable: kill it at any stage, re-run, it continues from the docs.

### First-draft layout (explicitly non-optimal, explicitly useful)

The agent produces an **initial placement and routing plan** — correct, not optimal — and says so:

- **Placement:** rule-driven, from LAYOUT.md intent: connectors on edges, decoupling caps at their IC pins, ESD at connectors, antenna keepout honored, crystal next to MCU, user-facing parts (buttons, LEDs) where the brief puts them. Written as actual coordinates into the .kicad_pcb.
- **Routing:** power nets and short critical nets routed by rule (USB differential pair length-matched via KiCad's tools where possible); remaining nets left as ratsnest or routed naively. Every routed net must pass DRC; nothing hand-wavy.
- **Honesty gate:** LAYOUT.md gets a `## Draft quality` section auto-written by the agent, listing exactly what is fine (budgets, keepouts, DRC-clean) and what a human or a specialist tool (Quilter, autorouter) should redo before fab. Non-optimal is acceptable; unlabeled non-optimal is not.
- **Positioning:** this makes layout tools *complements, not competitors* — copperhead produces the DRC-clean draft and constraints file they optimize from.

Delta 4 framing: a first-draft board that passes DRC in an hour vs. a blank canvas that takes a specialist a week. Optimization is iteration; the blank canvas was the bottleneck.

## 2.6 OpenSpec integration — the documentation layer

copperhead adopts [OpenSpec](https://github.com/Fission-AI/OpenSpec) (spec-driven development framework, Node ≥ 20 — same runtime) as the user-facing docs/change-management layer on top of the design docs.

### Two-tier memory model

| Tier | Location | Owner | Contents |
|---|---|---|---|
| **Spec tier (OpenSpec)** | `openspec/specs/` | user-reviewable truth | Requirements & scenarios per capability: power, connectivity, ui, enclosure, firmware. What the product must do and under what constraints |
| **Design tier (copperhead)** | `docs/` + `.copperhead/` | agent working memory | How it's achieved: BOM rationale, pinout, subsystem values, layout intent — plus the machine-readable constraint memory (below) |

### Constraint memory

The agent maintains `.copperhead/constraints.json` — a live, machine-readable registry built **simultaneously with the docs**: every time a constraint is stated (brief), assumed (flagged `ASSUMED`), or discovered (datasheet), it lands in both the human doc and the registry in the same tool turn:

```json
{
  "power.sleep_current_uA":  { "max": 25,  "source": "openspec/specs/power/spec.md#R2",
                               "affects": ["U2", "R7-absent", "GPIO-pullups"] },
  "rf.antenna_keepout_mm":   { "min": 5,   "source": "docs/LAYOUT.md", "affects": ["zone:top"] },
  "pins.strapping":          { "forbidden": ["GPIO0","GPIO3","GPIO45","GPIO46"],
                               "source": "esp32-s3 datasheet §2.4" }
}
```

Loaded into every run's system prompt; `check` validates the design against it mechanically where possible (leakage sums, keepout geometry, forbidden pins). The `affects` field is what makes propagation reliable — change a constraint and the agent knows exactly which parts to revisit.

An `affects` item that targets an artifact that does not exist yet (schematic, board, or BOM recorded before their pipeline stage) opens no revisit obligation at record time — it is marked `deferred` in the registry instead, and the obligation re-opens automatically at the start of the first run where the artifact exists. This keeps early docs-only stages from burning turns on ceremonial "not yet created" resolutions without losing the reconciliation guarantee: the revisit still happens, at the moment it can actually change the design.

### Change workflow (OpenSpec propose → apply → archive)

- `copperhead do "<request>"` first generates `openspec/changes/<id>/` (proposal.md, spec deltas, tasks.md), then implements against it; the ERC/DRC-clean commit archives the change. Every hardware change gets a paper trail: *why → what spec changed → what files changed → verification result*
- `copperhead create` seeds `openspec/specs/` from the brief as stage one — requirements with scenarios ("Given the device sleeps, when idle 1 year, then battery ≥ 20%") become the testable source that SPEC.md budgets derive from
- In `--interactive` mode, the human approves the proposal; in autonomous mode it's written and auto-approved with an `AUTO` marker — reviewable after the fact, never lost
- `openspec validate` runs inside `copperhead check`

### Trigger mechanics

OpenSpec is never user-triggered; copperhead drives it as subprocess tools (same pattern as kicad-cli):

| When | copperhead runs | Effect |
|---|---|---|
| `init` / `create` start | `openspec init` (once) | Scaffolds `openspec/`; agent seeds `specs/` from the brief |
| `do` — plan step | agent writes `openspec/changes/<id>/`, then `openspec validate --change <id>` | **Edit tools stay locked until the proposal validates.** The plan step *is* the proposal |
| `do` — after ERC/DRC pass + commit | `openspec archive <id>` | Deltas merge into `specs/`; change record closed by the same code path that committed |
| `check` | `openspec validate` | Part of the standard gate set |
| `--interactive` only | pause after proposal validation | Human y/n before edits unlock — the single manual trigger |

This kills the last "docs drift" failure mode: requirements (openspec) → budgets (SPEC.md) → constraints (constraints.json) → design (KiCad) form a chain where every link is checked by tooling, not memory.

## 3. CLI surface (Phase 1)

```
copperhead [repl] ["<change request>"] [--model …] [--allow-dirty]
    Interactive agent shell (default when no subcommand is given).
    Claude Code–style prompt loop on a TTY: each line runs one
    `do`-equivalent change (same gates, including the AC-3.8 dirty-tree
    refusal and the same off-by-default `--allow-dirty` escape hatch),
    then returns to the prompt.
    Slash commands: /help, /demo, /examples, /status, /check, /parts, /nets,
    /bom, /sync, /drift, /constraints, /openspec, /config, /git, /runs, /last,
    /model, /version, /clear, /quit. Inspect commands are verify-only (no LLM
    resolve / create). An optional first request runs before the loop. Non-TTY
    without a request refuses and points at `copperhead do`. With no model
    configured anywhere, a TTY session offers an interactive picker (also
    reachable later via /model). Session output mirrors to
    `.copperhead/runs/repl-<ts>.log` with AC-4.1 redaction applied.

copperhead demo [--tour] [--model …] [--dir <path>]
    Print a short tour of what the agent does (`--tour`), or scaffold
    `demo-runs/usb-c-breakout/` and run the create pipeline against the
    packaged USB-C power breakout brief (same as `npm run demo:simple`).

copperhead create --brief brief.md   # Mode A: full pipeline (§2.5)
copperhead init [--path hardware/]
    Detect .kicad_sch/.kicad_pcb, parse symbols/footprints/nets,
    generate docs/ skeleton pre-filled with the real BOM and pinout
    extracted from the schematic. Idempotent; never overwrites
    hand-edited docs without --force.

copperhead draft schematic [--json]
    Deterministically draft the schematic from its declared intent
    (schematic.intent.json): the engine computes every coordinate, wire,
    label, power symbol, and group box. No LLM, no network. Exits non-zero
    with numbered findings on a refused intent and writes nothing.

copperhead score schematic [--json]
    Quantitative drawing-quality score for the sheet: per-metric breakdown,
    weights, contributions, and the composite. Advisory only — the exit code
    is 0 regardless of the composite. No LLM, no network.

copperhead do "<change request>" [--model codex|gpt-5|claude] [--max-turns N]
    The core loop. See §4.

copperhead check          (alias: copperhead verify)
    Run ERC + DRC + doc-drift check; exit non-zero on violations.
    No LLM calls. Usable as CI step / pre-commit hook.

copperhead sync [--dry-run]
    Verify the entire design state for inconsistencies — doc tables vs
    schematic, constraints.json vs docs and openspec specs, PINOUT.md vs
    pins.h, DECISIONS/CHANGELOG coverage — then resolve the drift via a
    spec-gated agent run (same gates as `do`). Truth precedence: KiCad
    files are ground truth for as-built facts; openspec specs and SPEC.md
    budgets are ground truth for requirements. An inconsistency that
    implies a requirement violation is flagged for the human, never
    silently rewritten. `--dry-run` prints the full inconsistency report
    and writes nothing. Idempotent: a second run finds nothing to do.

copperhead explain <refdes|net|pin>       # stretch
    Answer "why is R7 here?" from docs + schematic context.

copperhead watch                          # Phase 2
    Start the live viewer (see §6).
```

Global flags: `--repo <path>`, `--dry-run` (propose diff, don't write), `--json` (machine-readable output).

---

## 4. The agent loop (`copperhead do`)

### 4.0 The workflow in plain words (canonical description — use in README/pitch)

It's a loop, and it looks a lot like pair-programming, except the codebase is a circuit board.

1. **Start from the docs.** Every decision lives in the design docs, so the agent reads those first and knows the whole design, not just the part in front of it.
2. **Talk through the change.** Describe what you want ("add an external key jack", "cut the sleep current"). The agent proposes the parts and circuit; you push back until the reasoning holds up.
3. **Edit the real files.** The agent writes the changes straight into the KiCad schematic and the design docs, using the same part names and net names everywhere so nothing drifts.
4. **Propagate.** Change one value, like the charge current or a pin, and it carries across every doc and the schematic that references it. This is the boring, easy-to-get-wrong step the agent is best at.
5. **Check the work.** The agent runs ERC/DRC, reads the errors back, and fixes them. Nothing is "done" until the tools agree.
6. **Write down why.** Every real decision gets a one-line reason next to it, so the next change doesn't quietly undo it.

§4.1 below is this loop made precise; §2.6 adds the OpenSpec proposal wrapper around steps 1–2 and the constraint registry behind steps 4–5.

### 4.1 Sequence

1. **Load memory.** Read all `docs/*.md` + the schematic file list into the system context. Docs are small by design (< ~2k lines total); include them whole.
2. **Plan.** Agent states, in one short block: what will change, which files are affected, which constraints are at risk (e.g. sleep-current budget).
3. **Edit.** Agent uses tools to modify KiCad files and docs. Edits to `.kicad_sch`/`.kicad_pcb` are **text edits on the s-expression source** (search/replace with context anchors) — no full-file regeneration, ever. Same net names and refdes everywhere.
4. **Verify.** Agent runs `run_erc` (always) and `run_drc` (if the .kicad_pcb changed). Parses violations.
5. **Repair.** If violations: fix and re-run, up to `maxRepairCycles` (default 5). If still failing: revert to the pre-run snapshot and report failure with the violation list.
6. **Propagate.** Agent runs `check_drift`; any doc that references a changed value/part/pin must be updated in the same run.
7. **Rationale.** Every non-trivial decision gets a one-line "why" written into the relevant doc.
8. **Commit.** `git commit` with a structured message (`copperhead: <request>\n\n<summary of edits + verification result>`). Requires clean working tree at start (§7 safety).

### 4.2 Tool schemas

| Tool | Signature | Notes |
|---|---|---|
| `read_file` | (path) → text | Repo-relative, sandboxed to repo root |
| `edit_file` | (path, old_string, new_string) → ok | Exact-match anchored replace; fails if not unique |
| `write_file` | (path, content) → ok | New files only (docs); refuses to overwrite .kicad_* |
| `search` | (regex, glob?) → matches | ripgrep-style over repo |
| `list_symbols` | (sch_path) → [{ref, value, footprint, sheet}] | From s-expression parse |
| `list_nets` | (sch_path) → [net names] | |
| `run_erc` | () → {violations: [...]} | `kicad-cli sch erc --format json --exit-code-violations` |
| `run_drc` | () → {violations: [...]} | `kicad-cli pcb drc --format json --exit-code-violations` |
| `export_svg` | (sch\|pcb) → path | For viewer + before/after diffing |
| `check_drift` | () → [{doc, claim, actual}] | Compares doc tables (BOM/pinout) against parsed schematic |

### 4.3 System prompt — key rules (verbatim requirements)

- You are a hardware design agent working on real KiCad source files. Edit s-expressions surgically; never regenerate a whole file.
- You cannot edit any file until your change proposal validates (§1.3 invariant 1). Write the proposal first; the edit tools appear only after it passes.
- The design docs are the memory. Read them before proposing anything; update them with everything you change.
- Hold **all** constraints simultaneously: electrical budgets (e.g. sleep current), voltage ranges, package availability, strapping pins, RTC-capability, antenna keepouts. A part that satisfies the obvious constraint but violates a budget is a bug.
- Check the MCU strapping table before assigning any pin. Check quiescent/leakage current of every part against the power budget in SPEC.md.
- Nothing is done until ERC (and DRC when applicable) passes. Read the violation report; do not guess.
- Write a one-line rationale next to every decision. If you remove a part, record why the absence is intentional (a missing pullup can look like a mistake).
- If a request would violate a documented budget or constraint, stop and say so — do not silently comply.

### 4.4 Provider abstraction

```ts
interface Provider {
  chat(messages: Msg[], tools: ToolSchema[], opts): Promise<Turn>;
}
```

- `openai.ts`: GPT-5 via chat completions + tool calling (hackathon shared key)
- `anthropic.ts`: Claude via messages API + tool use
- `codex.ts`: locally installed Codex CLI via the official SDK and saved `codex login` authentication; Codex runs read-only and returns structured Copperhead tool requests
- `claude-code.ts`: saved-login Claude Code via the Claude Agent SDK: a reasoning-only backend (no SDK tools, built-ins disabled, isolated cwd) mapped onto the single-turn `Provider` seam so the loop stays the driver. Selected by `--model claude-code` / `claude-code:<id>` (routed ahead of the `claude*` prefix); needs no `ANTHROPIC_API_KEY` (uses `CLAUDE_CODE_OAUTH_TOKEN` / the logged-in CLI); never falls back to a keyed provider. `@anthropic-ai/claude-agent-sdk` ships as an `optionalDependency` (its `@anthropic-ai/sdk >=0.93.0` peer is satisfied by copperhead's bumped core SDK), lazily imported and only loaded when `claude-code` is selected.
- `cursor.ts`: saved-login Cursor Agent CLI subprocess (`agent login`), reasoning-only (plan mode, sandbox, isolated workspace, JSON tool protocol, session resume via `--resume`). Selected by `--model cursor` / `cursor:<id>`; needs no model API keys; never falls back to a keyed provider. Optional `COPPERHEAD_CURSOR_PATH` (default `agent` on PATH).
- `openai.ts` compatible-endpoint mode: `--model compat:<id>` points the same provider at any OpenAI-compatible endpoint (Groq, OpenRouter, Gemini's compat endpoint, a local Ollama) via `baseURL` + `apiKeyEnv` (config, or `COPPERHEAD_BASE_URL` / `COPPERHEAD_API_KEY_ENV`). Only the `compat` route reads `baseURL`, so a stray value never redirects a `gpt-5` run; a loopback endpoint needs no credential.
- Selection: `--model` flag > `COPPERHEAD_MODEL` env > config.json > the available key, but **only when exactly one of `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is set**; with two or more present and no explicit selection, resolution refuses with an actionable error rather than silently favoring one (breaking change from "first key wins")
- All providers must pass the same integration test on the fixture repo

### 4.5 Budgets & failure modes

- `maxTurns` default 40; `maxRepairCycles` 5; per-run token budget logged
- On turn-budget exhaustion in an attended (TTY) run: print run stats (turns, files touched, open obligations, token usage) and ask whether to continue with more turns; declining, or a non-TTY run, fails as below. The extension can repeat; each is a fresh decision with fresh numbers.
- On any unrecoverable failure: preserve the touched work as a git stash entry named `copperhead failed run <run-id>`, restore the snapshot, print the stash ref and transcript path, exit 1
- Rate-limit (429): exponential backoff ×3, then fail over to the other **keyed** provider (`openai` ↔ `anthropic`) if a key exists; saved-login providers (`codex`, `claude-code`, `cursor`) never fail over to a keyed or alternate provider
- The Anthropic provider marks `cache_control` breakpoints (system prompt, last tool, last message block) so the resent conversation prefix is cached; reported input tokens include cache reads/writes

---

## 5. Config (`.copperhead/config.json`)

```json
{
  "schematic": "hardware/open-telegraph.kicad_sch",
  "board": "hardware/open-telegraph.kicad_pcb",
  "docs": "docs/",
  "model": "gpt-5",
  "maxTurns": 40,
  "stageMaxTurns": { "spec-seed": 60 },
  "budgets": { "sleep_current_uA": 25 }
}
```

`budgets` is free-form; keys are surfaced verbatim into the system prompt so the agent treats them as hard constraints. `stageMaxTurns` is optional: per-stage turn budgets for the create pipeline, keyed by stage name; stages without an entry use `maxTurns`.

---

## 6. Phase 2 — Live viewer (`copperhead watch`)

The "Cursor feel": see the board change as the agent works.

- Express server on `localhost:3663`, single-page app (no build step; one HTML file)
- Left pane: chat input → runs `copperhead do` in-process, streams agent turns (plan / edits / verify) over WebSocket
- Right pane: schematic + board SVG, re-exported via `kicad-cli ... export svg` after every file mutation (chokidar watcher), pushed over WS, pinned zoom/pan preserved across reloads
- Status bar: ERC/DRC state (red/amber/green), last-run rationale lines
- Before/after: keep the pre-run SVG; toggle to flick between them

Acceptance: type "add a second RGB LED on an RTC-capable pin" → watch schematic re-render + ERC flip green, with no manual refresh.

## 7. Safety rails

- Refuse to run `do` or `repl` on a dirty git tree (offer `--allow-dirty`, whose snapshot pairs a `git stash create` object for tracked changes with a tree object for untracked files, so the rollback restores both rather than letting `git clean` delete what the stash never captured). An untracked file that exists but cannot be read refuses the run by name: it cannot be snapshotted, and the rollback would delete it regardless, so proceeding would break exactly the promise `--allow-dirty` makes. Untracked paths that vanish before the snapshot is taken are skipped rather than refused
- All file tools sandboxed to repo root; no network tools in Phase 1
- `.env` in `.gitignore` from first commit; keys only via env vars — never written to any file, transcript, or commit
- Transcripts in `.copperhead/runs/` redact anything matching `sk-[A-Za-z0-9_-]+`
- The Codex CLI's native read access and `~/.codex/sessions/` logs are outside Copperhead's enforcement/redaction boundary; the Codex path documents this host-local exposure explicitly
- The agent never invents MPNs: any new part must come with a datasheet-verifiable justification in BOM.md, flagged `UNVERIFIED` for human review

## 8. Phase 3 — Integrations (post-hackathon roadmap; document, don't build)

- **CI**: GitHub Action running `copperhead check` (ERC + DRC + drift) with a badge — hardware repos get a green check like software
- **Simulation checkers**: ngspice (analog sanity), openEMS (EMC) as additional verify tools — architecture is checker-agnostic
- **KiCad plugin**: chat panel inside KiCad via the IPC API — the full-Cursor endgame
- **Part data**: live availability/pricing (Octopart/JLC), so "sourceable" becomes a checked constraint
- **Format expansion**: Altium file support; the agent core is format-agnostic, only tools change
- **Hosted**: private-repo SaaS, per-seat; payments via merchant-of-record (Dodo)

## 9. Acceptance criteria

Format: Given / When / Then. "Fixture" = the open-telegraph repo (or the tiny test project in `test/fixtures/`). All criteria are binary — they pass or they don't.

### AC-1 · `copperhead init`

- **AC-1.1** Given a KiCad repo with no `docs/`, when `copperhead init` runs, then `docs/SPEC.md`, `BOM.md`, `PINOUT.md`, `SUBSYSTEMS.md`, `LAYOUT.md` and `.copperhead/config.json` exist.
- **AC-1.2** BOM.md contains one row per schematic symbol with real refdes, value, and footprint parsed from the `.kicad_sch` — not placeholders. Row count equals `list_symbols` count.
- **AC-1.3** PINOUT.md contains the MCU's actual pin-to-net assignments parsed from the schematic.
- **AC-1.4** Re-running `init` on the same repo exits 0 and changes no hand-edited file (idempotent). With modified docs and no `--force`, it refuses and lists what it would overwrite.
- **AC-1.5** On a repo with no `.kicad_sch`, exits non-zero with a clear message (no stack trace).

### AC-2 · `copperhead check`

- **AC-2.1** On a clean fixture: exit 0, prints ERC ✓ DRC ✓ drift ✓, makes zero LLM calls (assert: no network to api.* hosts).
- **AC-2.2** With a deliberately broken schematic (unconnected pin): exit non-zero, violation printed with sheet/location.
- **AC-2.3** With a BOM.md value edited to disagree with the schematic (e.g. wrong resistor value): drift check fails and names the doc, the claim, and the actual value.
- **AC-2.4** `--json` emits machine-readable results (parseable, stable keys).
- **AC-2.5** Runs in < 60 s on the fixture.

### AC-3 · `copperhead do` — core loop

- **AC-3.1 (rename)** `do "rename net KEY_DAH to KEY_DASH"` → net renamed in every sheet it appears; PINOUT.md and SUBSYSTEMS.md updated; ERC exit 0; exactly one commit; no other net or doc line changed (diff inspected).
- **AC-3.2 (constraint reasoning)** `do "move the key input to a different RTC-capable pin"` → chosen pin is RTC-capable AND not a strapping pin (GPIO0/3/45/46 on ESP32-S3); transcript shows the strapping table was consulted; schematic + PINOUT.md agree; ERC exit 0.
- **AC-3.3 (add part)** `do "add a second RGB LED"` → new symbol with unique refdes, valid footprint from the existing library set, net connected to a real GPIO; BOM.md gains a row with MPN flagged `UNVERIFIED` and a one-line rationale; ERC exit 0.
- **AC-3.4 (budget refusal)** `do "add a 100kΩ pullup on KEY_DAH"` (which would leak ~33 µA against the 25 µA budget) → agent **refuses or proposes an alternative**, citing the budget from SPEC.md. It must not silently comply. This is the money demo.
- **AC-3.5 (repair loop)** Given an edit that first produces an ERC violation, the transcript shows: violation parsed → targeted fix → re-run → pass, within `maxRepairCycles`.
- **AC-3.6 (rollback)** If violations persist after `maxRepairCycles`, working tree equals the pre-run state (`git status` clean, files byte-identical), exit non-zero, transcript path printed.
- **AC-3.7 (surgical edits)** For every run above: the `.kicad_sch` diff touches only the s-expressions relevant to the change — file not regenerated (assert: < 5% of lines changed for AC-3.1).
- **AC-3.8 (dirty tree)** With uncommitted changes and no `--allow-dirty`: refuses to start. Holds for `repl` as well as `do`, since `repl` is the default command. With `--allow-dirty`, a rollback restores both the tracked modifications and the untracked files that were present before the run.
- **AC-3.9 (dry run)** `--dry-run` prints the proposed diff and writes nothing.
- **AC-3.10 (provider parity)** AC-3.1 passes with `--model codex`, `--model gpt-5`, `--model claude`, `--model claude-code`, `--model cursor`, and `--model compat:<id>` when each provider is configured.
- **AC-3.11 (saved login)** With `--model claude-code`, a logged-in Claude Code (`CLAUDE_CODE_OAUTH_TOKEN` set) and **no** `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, a `do` run completes through the normal verify/commit path; copperhead reads no credential store; and no key material appears in the transcript, summary, or tree (AC-4.1 holds). A missing optional dependency or an unauthenticated install fails through the rollback path with an actionable error, not a raw stack trace.
- **AC-3.12 (cursor saved login)** With `--model cursor`, a logged-in Cursor Agent CLI (`agent login`) and **no** model API keys, a `do` run completes through the normal verify/commit path; copperhead never reads Cursor credentials; unauthenticated or missing CLI installs fail with an actionable message and rollback.
- **AC-3.13 (compat credential resolution)** With `baseURL` and `apiKeyEnv` configured (via `.copperhead/config.json` or `COPPERHEAD_BASE_URL`/`COPPERHEAD_API_KEY_ENV`) and the named variable set, `--model compat:<id>` issues its requests to that endpoint using that credential; a credential present under a different variable name does not satisfy it.
- **AC-3.14 (compat locality)** A `baseURL` resolving to a loopback host (`localhost`, `127.0.0.1`, `::1`, or a `.local` suffix) requires no credential; a remote `baseURL` without its configured credential fails before any network call, naming the missing variable in the error.
- **AC-3.15 (compat routing is explicit)** Bare `compat` (no model id) and `compat:` (empty model id) are both rejected with an actionable message naming `compat:<model-id>`; a compatible endpoint has no default model to fall back to, unlike `codex`/`claude-code`/`cursor`.
- **AC-3.16 (compat endpoint isolation)** An exported `COPPERHEAD_BASE_URL`/`COPPERHEAD_API_KEY_ENV` does not change where a non-`compat` model (`gpt-5`, `claude`, etc.) sends its requests; only the explicit `compat:` prefix consults them.
- **AC-3.17 (compat prompt-privacy signal)** `doctor` reports a non-blocking `warn` line when the compat endpoint's host is documented as training on submitted prompts, and a non-blocking `info` line naming the host when no policy is on record; neither case fails the command. A true loopback endpoint (`localhost`, `127.0.0.1`, or `::1`, but not a `.local`/LAN host) bypasses this check entirely, since nothing leaves the machine.
- **AC-3.18 (compat never fails over to a paid key)** A rate limit against a `compat:<id>` endpoint never fails over to `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, even when one is present in the environment: the compat provider is not `'openai'` by name, so the same isolation that protects `codex`/`claude-code`/`cursor` (AC-3.11, AC-3.12) applies to it too.
- **AC-3.19 (ambiguous auto-selection refuses)** With no `--model`, no `COPPERHEAD_MODEL`, and no `model` in config, model resolution refuses with an actionable "ambiguous" error naming every credential found when two or more of `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` are set; with exactly one, that provider is selected as before. **Breaking change**: an environment with both keys set that previously auto-selected `OPENAI_API_KEY` now fails `do`/`sync`/`create`/`demo` until a model is chosen explicitly (`repl` degrades gracefully via its interactive picker instead).
- **AC-3.20 (compat cache is endpoint-scoped)** Re-running a cached `compat:<id>` request against a different `baseURL` calls the new endpoint rather than replaying the previous one's turns: one model id can be served by several hosts, so the id alone no longer identifies the backend. The endpoint enters the cache key only for the `compat` route, so a non-`compat` run's existing cache entries still replay unchanged.

### AC-4 · Safety

- **AC-4.1** No file in the repo, transcript, or any commit ever contains a string matching `sk-[A-Za-z0-9_-]{20,}` (grep the whole tree + `.copperhead/runs/` after all tests).
- **AC-4.2** A tool call with a path outside the repo root (e.g. `../../etc/hosts`) is rejected.
- **AC-4.3** `.gitignore` includes `.env` and `.copperhead/runs/` in the very first commit of the repo.

### AC-7 · `copperhead sync` — full-state consistency

- **AC-7.1 (resolve doc drift)** With BOM.md edited to disagree with the schematic, `sync` updates the doc to match the as-built schematic, appends a DECISIONS.md entry and a CHANGELOG.md entry, commits once, and exits 0; a `check` run immediately after is clean.
- **AC-7.2 (repair dual-write)** With a constraint stated in a doc but missing from `constraints.json`, `sync` adds the registry entry with the correct `source` and `affects`, and vice versa (registry entry with no doc mention gets the doc line).
- **AC-7.3 (never resolve a violation silently)** With an inconsistency that reflects a requirement violation (e.g. a part whose leakage breaks the sleep-current budget), `sync` does **not** rewrite either side to agree; it flags the violation with both sides and the governing spec/budget, and exits non-zero.
- **AC-7.4 (dry run)** `sync --dry-run` prints every detected inconsistency (doc, claim, actual, proposed resolution) and writes nothing (`git status` unchanged).
- **AC-7.5 (clean and idempotent)** On a consistent repo, `sync` exits 0 with "no inconsistencies", makes no edits and no commit; running `sync` twice in a row makes the second run a no-op.

### AC-15 · Turn-budget continue & loop efficiency (issue #15)

- **AC-15.1 (continue)** When `maxTurns` is reached in an attended run, granting extra turns continues the conversation from the same state, records a `budget-extended` transcript event, and the run can still succeed.
- **AC-15.2 (decline)** Declining at the prompt fails and restores the snapshot exactly as before.
- **AC-15.3 (non-interactive unchanged)** With no callback (CI, pipes), exhaustion fails and restores exactly as before.
- **AC-15.4 (cost visible)** The decision point shows turns used, files touched, open obligations, and cumulative tokens in/out.
- **AC-15.5 / AC-15.6 (batching guidance)** The system prompt workflow and the 5-turns-remaining nudge both instruct emitting multiple independent tool calls per response.
- **AC-15.9 / AC-15.10 (batch resolution)** `resolve_affected` accepts `resolutions: [...]`; entries resolve independently with per-entry results.
- **AC-15.12 / AC-15.13 (convergence feedback)** `run_erc`/`run_drc` without a configured artifact read as not-applicable-yet; `search` rejects an empty pattern with a corrective hint. (Obligation deferral for not-yet-built artifacts is provided by the persisted constraint-registry mechanism in AC-8's change, not re-implemented here.)
- **AC-15.14 / AC-15.15 (prompt caching)** The Anthropic provider sends three `cache_control` breakpoints (system, last tool, last message block) and counts cache-read/creation tokens in reported input usage.
- **AC-15.16 / AC-15.17 (work preservation)** Any run failure with touched files leaves a `copperhead failed run <run-id>` stash entry holding the work while the tree is restored byte-identical; a clean failure leaves no stash.
- **AC-15.18 / AC-15.19 (per-stage budgets)** `stageMaxTurns` in config overrides `maxTurns` for named create-pipeline stages; absent entries change nothing.
- **AC-15.20 – AC-15.22 (edit validation)** An `edit_file` that makes a loadable `.kicad_sch`/`.kicad_pcb` unloadable is reverted with kicad-cli's error; `.kicad_pro`/`.kicad_sym`/`.kicad_mod` edits are never probed or reverted; an already-unloadable file keeps repair edits.
- **AC-15.23 / AC-15.24 (content-aware completion)** The schematic stage completes only with symbols present and drift-clean BOM/PINOUT (layout-draft: a board with a footprint plus the LAYOUT.md marker); a successful run that leaves the contract unmet halts the pipeline for resume instead of advancing.
- **AC-15.25 / AC-15.26 (drift bootstrap)** Zero-symbol schematics produce no drift mismatches; `check` surfaces a non-failing warning when an empty schematic coexists with a populated BOM.md.
- **AC-15.27 (consecutive stalls)** Only consecutive tool-less turns count toward the stopped-without-finishing failure; the counter resets on any tool call.
- **AC-15.28 (load-failure ERC/DRC)** A missing ERC/DRC report raises an error quoting kicad-cli's own output and naming the likely load failure.
### AC-8 · Run observability (change: record-run-metadata)

- **AC-8.1 (metadata completeness)** The `run-start` event of any agent-loop run contains: copperhead version + install path, `kicad-cli`/Node/platform versions, model id + provider + selection source (`flag`/`env`/`config`/`openai-key`/`anthropic-key`), run id + ISO timestamp + command, interactive flag, the resolved config snapshot (`schematic`, `board`, `docs`, effective `maxTurns`, `maxRepairCycles`, `budgets`), git commit/branch/dirty + uncommitted count, pre-commit-hook presence, and open-constraint + prior-run counts. The pre-existing `request`/`model`/`provider` fields keep their names. Collection is LLM-free and network-free.
- **AC-8.2 (resolved, not raw)** `do "x" --max-turns 12` in a repo whose config says `maxTurns: 40` records turn budget **12**, and the selection source names the actual winner of flag > `COPPERHEAD_MODEL` > config > key-fallback. A repo with no schematic records `schematic: null` (key present).
- **AC-8.3 (probe degradation)** A failing environment probe (e.g. git branch unavailable) yields `null` for that field only; all other fields populate and the run proceeds — a metadata failure never aborts or alters a run.
- **AC-8.4 (three surfaces, one source)** `summary.md` contains an `## Environment` section whose values match the `run-start` event, and the CLI prints a header of ≤ 2 lines before the first turn showing at minimum: version, model + provider + selection source, stage `name (k/N)` when in a `create` pipeline, and turn budget.
- **AC-8.5 (run-end addenda on every path)** Every terminal branch (success, refusal, turn-budget, repair-cycles, provider error, stall, commit failure) emits a `run-end` event and a `## Run stats` summary section with: exit path (`done`/`refused`/`turn-budget-exhausted`/`repair-cycles-exhausted`/`commit-failed`/`provider-error`/`stalled`), turns used vs budget, repair cycles used vs budget, token totals + per-turn breakdown, and wall-clock duration; the CLI prints one final outcome line (exit path, verification, commit hash if any, duration, tokens).
- **AC-8.6 (commit failure is an outcome)** When the end-of-run git commit fails (e.g. `git add -A` exits 128 on an embedded repo), the run rolls back per the snapshot contract and ends with `exitPath: commit-failed`; `summary.md` is still written and names the git error; no unhandled stack trace reaches the user.
- **AC-8.7 (progress with tokens)** In plain mode, each turn's output is prefixed `[turn k/N · <in> in / <out> out]` with cumulative totals (compact `12.3k` formatting); tool results stay one line each.
- **AC-8.8 (interactive on a TTY)** With stdout a TTY and neither `--json` nor `--plain`: a bottom-pinned status line redraws in place (spinner while a provider call is in flight, elapsed time, turn counter vs budget, cumulative tokens); assistant text and tool results scroll above it; the final outcome line replaces it; cursor and status line are restored/cleared on exit including Ctrl-C. A renderer reused across runs (the `create` pipeline) renders every stage: each outcome line releases the status line and the next stage re-establishes it. Interactive chrome may use muted SGR color (copper accent, dim secondary text, green/amber/red for outcome); color is never required for correctness.
- **AC-8.9 (plain fallback)** With stdout piped, or `--json`, or the global `--plain` flag: output is line-oriented and contains zero ANSI escape sequences. With `--json`, progress lines go to stderr; stdout carries only the machine-readable result.
- **AC-8.10 (redaction holds)** A string matching `sk-[A-Za-z0-9_-]+` planted in any metadata field appears redacted in both the persisted `run-start` event and `summary.md` (extends AC-4.1 to the new surfaces).

### AC-16 · Deterministic schematic drafting (change: deterministic-schematic-drafting)

Placement, routing, and legibility are computed from the netlist rather than sampled from a model. The engine owns every coordinate; the model authors intent only.

**Engine — placement and routing**

- **AC-16.1 (reproducible placement)** The same IR drafted twice on machines with identical vendored symbol sources yields byte-identical `.kicad_sch` files.
- **AC-16.2 (on-grid by construction)** For any IR, every symbol origin and wire endpoint lies on the 1.27 mm grid, and the legibility checker's `off-grid` family reports zero findings.
- **AC-16.3 (drafts are legible)** A Tier C reference IR drafts to output with zero error-severity legibility findings.
- **AC-16.6 (unknown pin rejected)** An IR connecting `U1.99` when the resolved symbol has no pin 99 fails with a numbered finding naming U1, pin 99, and the symbol's actual pin range; the previous schematic is unchanged.
- **AC-16.7 (BOM mismatch rejected)** An IR part whose refdes is absent from BOM.md, or whose value differs from BOM.md's, fails validation naming the refdes and both values, before any placement runs.
- **AC-16.8 (power nets are never routed)** A power-class net reaching twelve pins draws one power symbol per reached pin and no wire spanning them.
- **AC-16.9 (undriven rail gets a PWR_FLAG)** A power-class net sourced only by a connector pin carries exactly one synthesized `PWR_FLAG`, and ERC reports no undriven-power violation.
- **AC-16.10 (declared no-connect passes ERC)** An IR declaring `U1.8` no-connect emits a `(no_connect …)` marker at that pin, and ERC reports no unconnected-pin violation for it.
- **AC-16.11 (report embeds check and score)** A successful draft's report carries the checker's findings (or a clean statement) and the score composite with its breakdown, without separate tool calls.
- **AC-16.31 (straight-through passives)** A series RC between two aligned pins, drafted within one group, puts both passives on the shared axis with zero bends in every wire of the chain.
- **AC-16.36 (series parts lie on the row)** A two-lead part whose run from an IC's side pin ends on a signal net is placed on that pin's row beside the IC, rotated so its near lead faces the pin and its far lead points away, one gap past the pin's stub; a horizontal-pinned two-lead part (diode, LED, fuse, switch) is oriented the same way, and may hang when its run ends on a rail or ground. Runs on rows one pitch apart do not overlap in x.
- **AC-16.37 (local runs are wired)** For every signal net, each cluster of endpoints within one group and within wire span of one another that routes cleanly is drawn as one wired run with one label, whatever the rest of the net does; a cluster that cannot be routed whole is drawn as its largest routable subset. A net that leaves the group therefore still wires the part on its pin.
- **AC-16.38 (nets are coloured by function)** Wires and labels of every rail net share one colour, every ground net another, and every family of signal nets sharing a prefix before the first underscore (two or more members) a colour of its own from a fixed palette in family-name order; a lone signal keeps the theme default.
- **AC-16.39 (test points rise beside their net)** A one-pin test point whose net reaches an IC's side pin within one group hangs above that pin's row beside the IC and is wired to it.
- **AC-16.40 (one axis per pin, level lanes)** Parts hung on one pin share one axis and meet the pin's row in one junction; the pins of one side of an anchor take lanes outward from the stub, a lane's range runs from its pin's row to its chain's end, drops on a side start below the side's lowest hung pin row and rises above its highest, and a hung part is wired to its pin whatever its lane's distance. A pin's lanes precede any part lying on its row.
- **AC-16.41 (connectors and switches anchor hangs)** After the group's ICs, each connector and switch claims the hangable parts on its pins as an IC does; a switch already hung on an IC pin anchors nothing.
- **AC-16.42 (a run may end in a transistor)** A series two-lead part whose far net has two endpoints, the other being a transistor's base or gate, ends the run with that transistor placed on the row, mirrored left-for-right when needed so the base faces the driving pin, collector up and emitter down; a transistor whose base or gate is on the pin's net lies on the row the same way. Transistors are not group anchors.
- **AC-16.43 (the far end of a run is a node)** Two-lead parts on the signal net at the far end of a series run whose other lead is on a rail or ground hang from the run's last part beyond its far lead, the first straight from the row's end and the rest on lanes past it, and are wired to it.
- **AC-16.44 (turned parts keep horizontal fields)** A symbol placed at rotation 90 or 270 stores its Reference and Value at angle 90, so KiCad draws them horizontally; the checker measures every property text at its stored angle plus the symbol's.
- **AC-16.45 (text keeps 0.8 mm of air)** Every engine clearance check between two texts (field against field, label against field, label against label) pads the candidate by 0.8 mm; two texts whose boxes touch are a collision.
- **AC-16.46 (flags read along the row)** A wired run's global flag is placed only at a horizontal wire end reading outward; when no such position clears anything the checker measures, every label of that net becomes a local label. A stub flag on a vertical stub reads horizontally when a horizontal draw clears. The checker treats only the wire behind a flag's tip as its attachment.
- **AC-16.48 (rows minimise the stack)** The shelf-wrap keeps the groups' declared order and chooses the row breaks among consecutive runs that fit the width so the total height of the rows is minimal; a group wider than the budget is its own row.
- **AC-16.49 (columns as well as rows)** When no order-preserving row layout fits a sheet, the shelf-wrap tries the column-major layout: consecutive groups stack top-to-bottom into columns no taller than the usable height, columns are as wide as their widest group, and the breaks minimise total width. The draft notes say which was used.
- **AC-16.50 (the title block is a corner)** Content may extend into the title strip when every group box that reaches into it stays clear of the title block's own corner (110 mm wide at the bottom right); the sheet fit and the frame clamp both honour this.
- **AC-16.51 (a group fills its band)** Under a band budget, a group's columns are balanced to the lowest height at which they fit the band side by side in one pass (channel and facing-label widening included), so a wide flat group folds into a grid instead of wrapping onto bands; the column splitter never yields more chunks than the budget requires.
- **AC-16.52 (lanes start at the drawn labels)** The lanes beside an anchor start past the reach of the labels actually drawn on that side: a pin whose parts hang reserves only its run's name, and only when the net has endpoints outside the group.
- **AC-16.53 (the squeeze)** After the first draft the engine measures each cell's drawn extent (body, fields, and the wires, labels and power symbols of the runs on its pins, hung parts rolled up to their anchor; shared runs attributed only through the wires touching the cell's own pins), drafts again with cells sized from those measurements plus one unit of pad, and keeps a round only when the group boxes shrink by at least three percent with no refused hang, no larger sheet, no merged nets and the label-overlap budget kept; at most three rounds, and only when `COPPERHEAD_DRAFT_SQUEEZE=1` asks for them. `sheetFit.squeeze` always reports rounds and box area before and after.
- **AC-16.54 (anchorless groups are shaped)** A group with no IC anchor is balanced to the lowest column height at which its columns fit side by side within two and a half times its square side, under any band budget.
- **AC-16.55 (rows are tighter than columns)** The vertical cell margin is two grid units; a pin facing up or down that carries a rail or ground reserves six units on that side; a hung chain's cell ends two units past the chain's power-symbol room; the power-symbol reserve is five units. Text gates are unchanged, so the tighter rows may not produce a collision.
- **AC-16.56 (space by real labels)** The label-extent estimate that spaces groups and columns omits the flag for a signal pin whose net stays inside the group, has at most the wired-run endpoint count, and ends otherwise only in two-lead parts or test points; every other signal pin keeps its flag reserve.
- **AC-16.57 (balanced column splits)** A column re-rowed into k chunks is split at the k−1 points that minimise the tallest chunk; only if that tallest chunk still exceeds the budget is the column filled greedily to the budget.
- **AC-16.58 (a bridge shares a lane)** A two-lead part between two pins of one IC hangs in the lane of the pin it is claimed from when that pin already has a hang, toward the other pin's row; the other pin's run reaches its far lead by a hook (row past the part, turn, back), a route candidate for two-stub clusters. With no lane to share it lies on the row.
- **AC-16.59 (shelf infill)** A cell of four or more pins with no lanes of its own, not a connector, moves from its column into the unused depth of another cell's side shelf when it fits below that side's lanes and label reach; the column it leaves narrows or disappears.
- **AC-16.60 (banks by rail)** Decoupling bank caps are ordered by rail then reference, and a bank row breaks before a rail whose caps would not all fit it.
- **AC-16.61 (boxes align)** Group boxes in one row of the wrap share the row's bottom edge; boxes in one column share the column's right edge.
- **AC-16.62 (masonry wrap)** When neither rows nor columns in declared order fit a sheet, groups are dealt to k columns (two to four), each column stacking its own groups in declared order with columns opened in reading order; every such deal is judged and the narrowest that fits the usable height is taken, ties to the shorter. The draft report names the shape (`groups laid in k columns … each column stacks its own groups`).
- **AC-16.63 (the look)** A sheet whose groups wrapped is drafted a second time with each group's label reach set to what its box was measured to grow past its cells in the first draft, plus one unit, in place of the per-pin estimate. The second draft is kept when it passes the gates and fits the same or a smaller sheet with no larger box area; `sheetFit.look` records both sheets and the verdict, and a note names a sheet change.
- **AC-16.64 (one gap between boxes, a caption band)** After the group boxes have grown to their text and aligned, every box and everything drawn in it moves so that neighbouring boxes along and across the lines of the wrap are exactly four grid units apart, boxes of a row share their top and boxes of a column their left; drawn items are attributed to groups by the pins on their wired run before any move, and content moves by whole grid units. No drawn item of a group starts above the caption's bottom plus one unit. The look measures a box's growth above and below its cells as well as beside them.
- **AC-16.47 (group boxes never intersect)** When two drawn group boxes intersect, the right-hand group's tiling reserve widens by the overlap and the sheet is drafted again, at most three times, deterministically.
- **AC-16.35 (parts hang on the pin they serve)** A vertical two-lead part whose net reaches an IC's side pin within one group is placed on that pin's row beside the IC, below it when entered through its top lead and above it through its bottom lead, with a series chain continued through two-endpoint links; every hangable endpoint of the pin's net hangs, so the net draws as one wired net with one label. A hang the clearance check refuses is drawn in a column and reported by name in the draft notes.

**Emission — determinism and fidelity**

- **AC-16.4 (byte-identical regeneration)** Drafting the same IR, committing, and drafting again leaves `git diff` over the schematic empty.
- **AC-16.5 (library upgrade is inert)** When the installed KiCad symbol library changes after a symbol was vendored, re-drafting the same IR is byte-identical to the pre-upgrade output, and `verify_symbols` reports the divergence between vendored and installed sources.
- **AC-16.12 (output loads in kicad-cli)** Every golden IR drafted in CI loads in `kicad-cli` without error, and ERC runs to completion.
- **AC-16.13 (connectivity matches intent)** Parsing a drafted reference IR yields a net list equal to the IR's connection list, with no-connect pins excluded.

**Legibility checker**

- **AC-16.27 (clean fixture is clean)** The checker reports zero findings at every severity on the well-drafted fixture schematic.
- **AC-16.28 (checker is inert)** Running the checker leaves the schematic's bytes unchanged and makes no subprocess or network call.
- **AC-16.29 (grid findings lead)** On a sheet with both `off-grid` findings and findings from other families, the `off-grid` findings appear before every other family in the report.
- **AC-16.30 (family can be disabled)** With `legibility.severity.crowding` set to `off`, no `crowding` findings are produced and the family is listed as disabled in the report.

**Scoring and the three-tier harness**

- **AC-16.14 (scoring is reproducible)** Two scorer runs on the same schematic produce identical metrics and composite.
- **AC-16.15 (error finding caps the score)** A sheet scoring well on every metric but carrying one error-severity legibility finding reports a composite capped below the Tier A floor, with the cap stated in the breakdown.
- **AC-16.16 (Tier A catches false positives)** A checker or scorer change that raises an error-severity finding on a Tier A sheet fails CI, naming the sheet and the finding.
- **AC-16.17 (Tier B catches detection regressions)** A change that stops a Tier B fixture's pinned finding from being reported fails CI, naming the fixture and the missing finding.
- **AC-16.18 (Tier C catches engine regressions)** An engine change that alters a Tier C output's bytes or lowers its pinned score fails CI with the file diff or the score delta.
- **AC-16.32 (aesthetic metrics are measured)** The breakdown reports axis-alignment ratio, spacing uniformity, straight-wire ratio, label alignment, whitespace balance, and pair symmetry as individual metrics with their weights and contributions.
- **AC-16.33 (wiring style is measured)** The breakdown reports `pin-attachment` (share of two-pin parts with a pin wired, through endpoint and T joins, to another part's pin), `island-parts` (share of two-pin parts whose every pin ends in a label or nothing), `power-symbol-economy` (power symbols per part) and `labels-per-part` as individual metrics; a resistor wired to an IC pin scores attachment 1 and a resistor hung on two labels scores 0 with islands 1.
- **AC-16.34 (style composite is convention-free)** The report carries a wiring-style composite computed from the AC-16.33 metrics, crossings per wire and the straight-wire ratio only; it is never capped by legibility findings, so a sheet with no group rectangles and an engine draft of the same circuit compare on one scale, and `copperhead score schematic --file <sheet>` reports it for any sheet without a repo.

**Agent loop and create pipeline**

- **AC-16.19 (model authors no geometry)** When the schematic stage completes in drafting mode, every geometry element was written by the engine and the transcript holds no `edit_file` call against the schematic.
- **AC-16.20 (stale draft does not complete the stage)** When the schematic on disk does not match a re-draft of the current IR, `create` reports the stage contract as unmet with a resume hint to re-draft, and does not advance.
- **AC-16.21 (score is recorded)** A schematic stage completing with an engine-drafted sheet records the score composite and per-metric breakdown in the run summary.
- **AC-16.22 (illegible sheet does not complete the stage)** When the stage's run succeeds with symbols present and drift clean but the checker reports error-severity legibility findings, `create` reports the contract as unmet with finding counts by kind, does not advance, and a re-run resumes at the schematic stage.
- **AC-16.23 (hand edit is redirected to the IR)** An `edit_file` call against an engine-drafted schematic during the schematic stage is refused naming `draft_schematic` as the correct path, and no file changes.
- **AC-16.24 (`finish` refuses while illegible)** Calling `finish` with outcome "done" while error-severity legibility findings remain lists them as unmet obligations, and the run does not conclude as done.

**CLI surface — legibility never gates `check`**

- **AC-16.25 (illegible schematic still exits zero)** `check` on a repo with error-severity legibility findings but clean ERC and DRC prints them under a legibility heading and exits 0.
- **AC-16.26 (score rides along without gating)** `check --json` on a repo with a drafted schematic and a low composite carries the `score` object with composite and breakdown, and the exit code is unaffected.

### AC-5 · Viewer (Phase 2 — only if built)

- **AC-5.1** `copperhead watch` serves on localhost; page shows current schematic SVG within 2 s of load.
- **AC-5.2** During a `do` run, the SVG re-renders without manual refresh after each file mutation; ERC/DRC status chip updates red→green.
- **AC-5.3** Before/after toggle flips between pre-run and current render.
- **AC-5.4** Agent plan/edit/verify turns stream into the left pane as they happen.

### AC-6 · Submission readiness (hard gate, 5:30 PM)

- **AC-6.1** Repo is public; README quickstart works on a clean machine (fresh clone, `npm i -g .` or `npx`, kicad-cli present) — actually tested, not assumed.
- **AC-6.2** One full recorded run (screen capture) exists locally — the demo fallback.
- **AC-6.3** 1-minute video exported and uploaded.
- **AC-6.4** At least AC-3.1, AC-3.2, and AC-3.4 pass live on the demo machine — these three are the pitch.

**Priority if time runs out:** AC-3.4 > AC-3.2 > AC-3.1 > AC-2.1 > AC-1.2 > everything else. The budget-refusal demo (AC-3.4) is the single strongest proof that this is reasoning, not autocomplete.

## 10. Non-goals (hackathon day)

- No autorouting, no placement optimization
- No full s-expression round-trip library (parse for *reading* lists/nets only; *edits* are anchored text replaces)
- No auth, no hosting, no billing
- No Altium/Eagle formats
- No Windows support guarantees (macOS/Linux only today)

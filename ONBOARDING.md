# Onboarding: your first week on copperhead

Welcome. This guide is for people joining the copperhead team. It assumes you can read TypeScript and use git, and it assumes nothing about circuit boards. By the end you should be able to explain what copperhead does, trace a run through the code, and ship your first pull request without tripping over the rules that keep the tool honest.

Read it top to bottom once. After that, use the [code map](#7-where-things-live) and the [gotchas](#10-gotchas-that-cost-people-time) as reference.

**Contents**

1. [The short version](#1-the-short-version)
2. [Hardware basics for software people](#2-hardware-basics-for-software-people)
3. [Set up your machine](#3-set-up-your-machine)
4. [Your first hour: run it for real](#4-your-first-hour-run-it-for-real)
5. [What happens inside one run](#5-what-happens-inside-one-run)
6. [The create pipeline, stage by stage](#6-the-create-pipeline-stage-by-stage)
7. [Where things live](#7-where-things-live)
8. [The rules you must not break](#8-the-rules-you-must-not-break)
9. [Making your first change](#9-making-your-first-change)
10. [Gotchas that cost people time](#10-gotchas-that-cost-people-time)
11. [Glossary](#11-glossary)
12. [What to read next](#12-what-to-read-next)

## 1. The short version

copperhead is a command-line AI agent that designs and edits circuit boards. Think of a coding agent working on a codebase, except the codebase is a KiCad project. You tell it "add reverse-polarity protection on VIN" and it reads the design docs, plans the change, edits the real KiCad files, runs KiCad's own checkers, fixes what they complain about, and commits.

There are two ways in:

| Command | Starts from | Ends with |
| --- | --- | --- |
| `copperhead do "<change>"` | An existing KiCad repo | One verified, committed change |
| `copperhead create --brief brief.md` | An empty git repo and a product brief | A full design: specs, parts list, schematic, board, fab files, firmware stub, bring-up plan |

`create` is really just `do` run eight times, once per stage, with a stage-specific prompt and a stage-specific definition of "done".

Two ideas shape everything in this repo, and you will hear them in every code review:

- **Spec-gated in.** The agent cannot edit a file until it has written a change proposal and that proposal validates. The edit tools are not hidden behind a polite instruction; they are missing from the tool list until validation passes.
- **Verification-gated out.** Nothing counts as done until KiCad's checkers pass. If the agent cannot get there, the whole run rolls back to a git snapshot.

If you remember nothing else, remember those two.

## 2. Hardware basics for software people

You do not need to be an electrical engineer to work here, but you need the vocabulary. Here it is with the software analogy that usually makes it click.

**PCB (printed circuit board).** The green board inside every electronic device. Parts are soldered onto it and copper tracks connect them.

**KiCad.** The free, open-source tool engineers use to design PCBs. copperhead never replaces it; KiCad stays the editor and copperhead edits KiCad's files. We drive KiCad from the command line through `kicad-cli`.

A KiCad design has two halves:

| Half | File | What it is | Software analogy |
| --- | --- | --- | --- |
| Schematic | `.kicad_sch` | The logical wiring diagram: which pin connects to which | Source code |
| Board (layout) | `.kicad_pcb` | The physical board: where each part sits and where the copper runs | The compiled binary |

Every part needs two library files, and they must agree with each other:

| Library item | What it describes | Example |
| --- | --- | --- |
| **Symbol** | How the part is drawn in the schematic, with numbered pins | `Device:R` is the generic resistor symbol with pins 1 and 2 |
| **Footprint** | The copper pads the part is soldered onto | `Resistor_SMD:R_0603_1608Metric` is the pad pattern for a 1.6 mm x 0.8 mm resistor |

Library ids use the form `Library:Name`. A symbol says "pin 1, pin 2"; the footprint says "pad 1 is here, pad 2 is there". If symbol pin 1 means "power" but footprint pad 1 sits under the part's ground leg, the board is wired wrong. A lot of copperhead code exists to catch exactly that kind of mismatch.

More words you will see constantly:

- **Net.** One electrical connection, like `GND` or `3V3`. Think of it as a variable name shared by every pin connected to it.
- **Refdes (reference designator).** The unique name of one part on a board: `R1`, `C4`, `U1`. Think of it as a primary key.
- **BOM (bill of materials).** The shopping list: every part, its value, its footprint, and its manufacturer part number (MPN).
- **ERC (electrical rules check).** KiCad's linter for schematics. It catches unconnected pins, two outputs driving each other, and so on.
- **DRC (design rules check).** KiCad's linter for boards. It catches tracks too close together, parts overlapping, copper outside the board edge.
- **Datasheet.** The manufacturer's PDF describing a part: pinout, voltage limits, current draw. The real source of truth for a part.
- **Gerbers.** The files you send to a factory to have the board made. Roughly, the "release build".

### What a KiCad file looks like

KiCad files are plain text in a Lisp-like format called s-expressions. Here is the resistor `R1` from our test fixture, [`test/fixtures/open-key/hardware/open-key.kicad_sch`](test/fixtures/open-key/hardware/open-key.kicad_sch), lightly trimmed:

```lisp
(symbol
  (lib_id "Device:R")
  (at 88.9 95.25 0)
  (property "Reference" "R1" (at 91.44 94.6149 0))
  (property "Value" "10k" (at 91.44 97.1549 0))
  (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 87.122 95.25 90))
  (property "Datasheet" "~" (at 88.9 95.25 0))
  (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000001"))
  (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000002")))
```

You can read the whole design story from it: R1 uses the generic resistor symbol, its value is 10k, it will be built with the 0603 resistor footprint, and nobody has attached a datasheet yet (`"~"` means empty).

Because these files are text, copperhead can edit them the way a coding agent edits source: by finding an exact, unique piece of text and replacing it. It never parses the file into a data structure and writes it back out. That rule matters a lot; see [section 8](#8-the-rules-you-must-not-break).

## 3. Set up your machine

You need:

- **Node.js 20 or newer**
- **git**
- **KiCad 8 or newer**, with `kicad-cli` on your `PATH`. On Windows and macOS copperhead also looks in the standard install folders, and `COPPERHEAD_KICAD_CLI` overrides the path if yours is somewhere unusual.
- **A model backend**, only for the commands that call an LLM. Either an `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in your environment, or a saved login for one of the supported agent CLIs (for example `--model codex` or `--model cursor`). The README's [CLI section](README.md#cli) lists every `--model` value.

Then, from a clone of the repo:

```bash
npm install
npm run dev -- --help     # runs the CLI straight from src/ through tsx
npm run dev -- doctor     # checks node, kicad-cli, git, openspec and your model credential
npm run typecheck
npm test
```

`doctor` is the fastest way to find out what is missing. It never calls a model and never touches the network, so run it whenever something feels off.

`npm test` runs the offline suite. It needs `kicad-cli` (a lot of tests shell out to it) but no API key: tests that call a live model skip themselves unless a key or `COPPERHEAD_TEST_CODEX=1` is set.

Keys only ever live in environment variables. Never put one in a file in the repo, not even temporarily.

## 4. Your first hour: run it for real

Reading code is slower than watching it work. Do these three exercises in order.

### Exercise 1: the deterministic checks (no model needed)

The `manual-tests/` folder creates throwaway git repos under `manual-tests/runs/`, which is gitignored. The `edit` sandbox is a copy of `open-key`, our small fixture board.

```bash
./manual-tests/setup.sh edit
npm run dev -- --repo manual-tests/runs/edit init
git -C manual-tests/runs/edit add -A
git -C manual-tests/runs/edit commit -m "scaffold docs"
npm run dev -- --repo manual-tests/runs/edit check
```

`init` reads the schematic and writes a `docs/` folder: `SPEC.md`, `BOM.md`, `PINOUT.md`, `SUBSYSTEMS.md`, `LAYOUT.md`, `DECISIONS.md`, `CHANGELOG.md`. It also writes `.copperhead/config.json` and installs a git pre-commit hook. Open `docs/BOM.md` and you will see every part pulled out of the schematic, with each MPN marked `UNVERIFIED`.

`check` runs ERC, DRC, a drift check between the docs and the schematic, constraint checks and OpenSpec validation, and it prints legibility findings as advice. It never calls a model and never uses the network, which is why it is safe in CI and in that pre-commit hook.

Two things may surprise you on the first try:

- The pre-commit hook is a one-line script that runs `copperhead check` from your `PATH`. If you have not installed copperhead globally, the hook cannot find it. If you have, and `check` fails, the commit is blocked.
- The fixture was saved with an older copy of KiCad's resistor symbol. On a newer KiCad (10.0.4, for example), ERC reports two `lib_symbol_mismatch` warnings for R1 and R2, `check` exits 1, and the hook blocks the commit. In this throwaway sandbox it is fine to commit with `git commit --no-verify`. Never do that in a real design repo.

Now break something on purpose. Edit `docs/BOM.md` in the sandbox and change R1's value from `10k` to `4.7k`, then run `check` again. Among the other lines you will see:

```text
DRC ✓
drift: BOM.md claims "R1 value 4.7k" but actual is "R1 value 10k"
```

The doc claims one thing and the schematic says another, and `check` names both. That drift report is the core promise of the product: docs and design cannot quietly disagree.

### Exercise 2: one real change with `do` (needs a model)

Put `BOM.md` back the way it was, then:

```bash
npm run dev -- --repo manual-tests/runs/edit do "Rename the EN net to CHIP_EN and propagate the change everywhere"
```

Watch the output. You will see the agent plan, call `propose_change` and `validate_change`, get its edit tools unlocked, edit the schematic, run `run_erc` and `check_drift`, record a decision, and call `finish`. Afterwards look at:

- `git -C manual-tests/runs/edit log --stat` to see the single commit the run made
- `docs/DECISIONS.md` and `docs/CHANGELOG.md` for the reasoning it wrote down
- `.copperhead/runs/<timestamp>/summary.md` for a human-readable summary, next to the full JSONL transcript

### Exercise 3: watch the safety net

Two more experiments, both in the same sandbox:

- Run `do` with `--dry-run`. The agent does the whole job, verifies it, and then the changes are reverted instead of committed.
- Add a budget to `.copperhead/config.json`, for example `"budgets": { "sleep_current_uA": 25 }`, commit it (with `--no-verify` if the hook blocks it, as above), and ask for something that would obviously blow it, like "add an always-on power LED". The agent should refuse and explain the arithmetic instead of making the change. That refusal path is one of our acceptance criteria.

When you want to see the full `create` pipeline, `./manual-tests/setup.sh create` makes an empty repo, and the [manual tests README](manual-tests/README.md) has the exact command. It takes a while and costs real tokens, so save it for when you have a reason.

## 5. What happens inside one run

This is the most important section for reading the code. Every `do` run, and every stage of `create`, goes through `runAgentLoop` in [`src/agent/loop.ts`](src/agent/loop.ts). Here is the run from exercise 2, step by step, with the file that does each step.

**Step 1: preflight and snapshot.** `gitPreflight` in [`src/util/git.ts`](src/util/git.ts) refuses to run outside a git repo, in a repo with no commits, or on a dirty working tree (unless you pass `--allow-dirty`). Then `snapshot` records the current HEAD. Every failure path later restores this snapshot, which is why a failed run leaves your repo exactly as it was.

**Step 2: build the system prompt.** `buildSystemPrompt` in [`src/agent/prompts.ts`](src/agent/prompts.ts) concatenates the fixed rules, the workflow, any budgets from `.copperhead/config.json`, the constraint registry from `.copperhead/constraints.json`, and every markdown file in `docs/`. The agent starts each run already knowing the whole design. This is what we mean by "docs as memory": there is no hidden database, only markdown you can read and review.

**Step 3: the turn loop.** The loop sends the conversation to the provider, gets back text and tool calls, runs the tools, and appends the results. A run has a turn budget (`maxTurns`, default 40). Turns are the scarce resource, so the prompt pushes the model to batch independent tool calls into one reply.

**Step 4: plan, then unlock.** At the start, the tool list contains only read-only tools such as `read_file`, `search`, `list_nets`, `run_erc` and `check_drift`, plus `propose_change`, `validate_change` and `finish`. The agent writes a proposal into `openspec/changes/<id>/` and validates it. Only then does `ctx.editsUnlocked` flip to true, and only then do `edit_file`, `write_file`, `move_footprint`, `draft_schematic`, `record_decision` and friends appear. The gate lives in [`src/capabilities/index.ts`](src/capabilities/index.ts): every tool marked `requiresUnlock` gets a gate of `ctx => ctx.editsUnlocked`, and [`src/agent/registry.ts`](src/agent/registry.ts) leaves gated tools out of the list it sends to the model.

**Step 5: edit and verify.** Edits are anchored text replacements. Every KiCad edit opens obligations in the sync-obligations ledger ([`src/agent/ledger.ts`](src/agent/ledger.ts)): ERC must pass, DRC too if the board changed, the drift check must run clean, and a changelog entry is due. Running the checker tools clears them. For example, `onKicadEdit` for a `.kicad_pcb` file adds `erc`, `drc`, `drift` and `changelog` obligations.

**Step 6: repair.** If ERC fails, the agent reads the normalized violation report and tries again. A repair that does not improve on the previous result counts against `maxRepairCycles` (default 5). Run out and the run fails and rolls back.

**Step 7: finish.** The `finish` tool, near the bottom of [`src/capabilities/handlers.ts`](src/capabilities/handlers.ts), is where "done" is decided. It refuses with a list of problems if ERC or DRC has not passed since the last edit, if any ledger obligation is open, or if the `create` stage's own contract (`stageGate`) is not met. The model has to fix each item and call `finish` again. `finish` with outcome `refuse` is the other exit, used when a request would break a budget.

**Step 8: commit or roll back.** On success the loop appends to `CHANGELOG.md` and makes one commit for the run. If the repo has an OpenSpec workspace, it then archives the change in a small follow-up commit. On refusal or failure it calls `restore`, which does `git reset --hard` to the snapshot plus `git clean`, while keeping `.copperhead/runs/` so the transcript of what went wrong survives.

Here is a real excerpt from an early pipeline run ([`pipeline-run-logs/02-run-through-part-selection.log`](pipeline-run-logs/02-run-through-part-selection.log)), the architecture stage of a USB-C breakout board, trimmed down to the tool calls:

```text
[turn 3/40 · 4 in / 329 out]
  [propose_change] proposal written to openspec/changes/architecture-subsystems/
  [validate_change] validation passed; edit tools are now unlocked
[turn 4/40 · 6 in / 4.9k out]
  [write_file] wrote docs/SUBSYSTEMS.md
[turn 5/40 · 8 in / 8.2k out]
  [check_drift] no schematic configured; drift vacuously clean
  [record_decision] decision recorded
  [finish] all gates satisfied; run will commit
committed 77d70fe241 (2 file(s))
```

Every step above is visible: propose, validate, unlock, edit, verify, record, finish, commit.

### Providers

The loop never talks to a vendor SDK directly. Each backend lives in [`src/agent/providers/`](src/agent/providers/) and converts between its own format and the internal `Msg`, `ToolCall` and `Turn` types in [`src/agent/types.ts`](src/agent/types.ts). API providers (OpenAI, Anthropic, any OpenAI-compatible endpoint) use native tool calling. The saved-login CLI providers use a text protocol from [`tool-protocol.ts`](src/agent/providers/tool-protocol.ts): the model replies with one fenced JSON block like `{"tool": "read_file", "args": {"path": "docs/BOM.md"}}` and copperhead runs it. Either way, the CLI backends are only the "reasoning half": every file edit, gate and check still happens inside copperhead.

Model routing is by prefix and lives in `makeProvider` in [`loop.ts`](src/agent/loop.ts). If you add a provider, keep all provider-specific code inside its own file and add its tests next to the existing `*-provider.test.ts` files.

## 6. The create pipeline, stage by stage

`copperhead create` is defined in [`src/commands/create.ts`](src/commands/create.ts) as an array called `STAGES`. Each stage has a name, a prompt, and an `isComplete` function that looks at the repo and decides whether that stage is already done. That last part is what makes the pipeline resumable: when a stage fails you fix the cause and rerun the same command, and every stage whose `isComplete` returns true is skipped.

| # | Stage | What the agent produces | When it counts as done |
| --- | --- | --- | --- |
| 1 | `spec-seed` | `docs/SPEC.md`, with every budget also recorded as a constraint | The Budgets section has real content, not just the scaffold comment |
| 2 | `architecture` | `docs/SUBSYSTEMS.md`: one section per subsystem with reasoning | At least one real section with prose under it |
| 3 | `part-selection` | `docs/BOM.md` with real MPNs, each flagged `UNVERIFIED` | At least one real MPN, and every footprint id resolves to an installed footprint |
| 4 | `schematic` | `schematic.intent.json`, drawn into the `.kicad_sch` by the drafting engine | Has symbols, drift-clean, ERC-clean, no error-level legibility findings, and matches a fresh re-draft of the intent |
| 5 | `layout-draft` | Parts placed on the board, short critical routes, a `## Draft quality` section in `LAYOUT.md` | The board matches the schematic part for part and pad for pad, DRC passes, and Draft quality is filled in |
| 6 | `outputs` | Gerbers, drill files, DXF, STEP, SVG renders, BOM files in `outputs/` | At least one Gerber file exists |
| 7 | `firmware` | A `firmware/` scaffold with `pins.h` generated from `PINOUT.md` | At least one source file exists |
| 8 | `devplan` | `docs/DEVPLAN.md`: bring-up order, test points, risks | The file has a heading and real content |

A few stages do deterministic work around the agent, and these are the places new joiners most often miss.

**Before stage 4 (the footprint stop).** `bomFootprintStop` checks every footprint in `BOM.md` against the installed KiCad libraries using the resolver in [`src/kicad/footprints.ts`](src/kicad/footprints.ts). If a library is simply not installed, the run stops and tells the human to install it. It never substitutes a "similar" footprint, because that is how a board ends up with pads that do not match the part.

**Stage 4 (the agent writes intent, not geometry).** The agent never places a wire by hand. It writes a JSON description of the circuit, and the deterministic drafting engine in [`src/kicad/draft/`](src/kicad/draft/) computes every coordinate, wire and label. A trimmed example from [`test/fixtures/draft/schematic.intent.json`](test/fixtures/draft/schematic.intent.json):

```json
{
  "version": 1,
  "parts": [
    { "ref": "R1", "libId": "Device:R", "value": "10k",
      "footprint": "Resistor_SMD:R_0603_1608Metric", "group": "MCU" },
    { "ref": "C1", "libId": "Device:C", "value": "100n",
      "footprint": "Capacitor_SMD:C_0402_1005Metric", "group": "MCU" }
  ],
  "nets": [
    { "name": "GND", "pins": ["J1.2", "U1.2", "R2.2", "C1.2"] }
  ]
}
```

`"C1.2"` means "pin 2 of part C1". Validation cross-checks this file against `BOM.md` and against the real pins in the installed symbol library, and it checks each symbol's pins against its footprint's pads. Symbols get copied into a committed `sym-lib-cache/` the first time they are used, so a later KiCad library upgrade cannot silently change a drawing. You can run the engine by hand with `copperhead draft schematic` and score the result with `copperhead score schematic`; neither calls a model. The [schematic drafting](docs/src/content/docs/reference/schematic-drafting.md) and [intent file](docs/src/content/docs/reference/schematic-intent.md) pages go deeper.

**Before stage 5 (populate).** `populateBoard` in [`src/kicad/populate.ts`](src/kicad/populate.ts) exports the netlist from the schematic, puts every footprint on the board with its pad nets, and packs them on a grid. The populated board must pass DRC before the agent gets its first turn. The agent then moves parts with `move_footprint` and may add tracks, but the stage gate fails if it adds, deletes or rewires a single footprint or pad.

**After any stage fails.** The pipeline asks the model, on a separate turn with no tools, whether a retry is likely to help (see [`src/agent/recovery.ts`](src/agent/recovery.ts)). On "retry" it runs the stage again with that guidance, up to `maxStageRetries` (default 2). On "abort" it stops and prints the exact command to resume.

After each KiCad stage, the pipeline also renders the schematic and board to SVG under `.copperhead/runs/<id>/artifacts/`. When a run looks fine on paper but you suspect the drawing is wrong, look there first.

## 7. Where things live

| Path | What is in it | Start with |
| --- | --- | --- |
| [`src/cli.ts`](src/cli.ts) | Every command and flag, built with commander | Search for `.command(` |
| [`src/commands/`](src/commands/) | One file per command: `create`, `check`, `sync`, `doctor`, `export`, `repl`, `demo`, `skill` | `check.ts` (short, and deterministic) |
| [`src/agent/`](src/agent/) | The loop, ledger, prompts, transcripts, rendering, recovery, response cache | `loop.ts`, then `ledger.ts` |
| [`src/agent/providers/`](src/agent/providers/) | One adapter per model backend | `openai.ts` |
| [`src/capabilities/`](src/capabilities/) | Every agent tool: schema, gate and handler | `handlers.ts` |
| [`src/kicad/`](src/kicad/) | `kicad-cli` wrapper, read-only s-expression parser, report normalizer, footprint and symbol resolution, board populate, legibility checks, fab export | `cli.ts`, `sexp.ts`, `footprints.ts` |
| [`src/kicad/draft/`](src/kicad/draft/) | The deterministic schematic drafting engine | `draft.ts`, then `ir.ts` |
| [`src/memory/`](src/memory/) | `init` scaffolding, drift detection, the constraint registry, BOM table parsing | `drift.ts` |
| [`src/review/`](src/review/) | `copperhead review`, an experimental grounded design review | `run.ts` |
| [`src/mcp/`](src/mcp/) | `copperhead mcp`, an experimental MCP server exposing only gated, outcome-level tools | `server.ts` |
| [`test/`](test/) | The vitest suite, roughly one file per feature | `ledger.test.ts`, `safety.test.ts` |
| [`test/fixtures/`](test/fixtures/) | Small real KiCad projects, including `open-key` | `open-key/hardware/` |
| [`manual-tests/`](manual-tests/) | Sandboxes for running the CLI by hand, plus reference boards | [`README.md`](manual-tests/README.md) |
| [`examples/`](examples/) | Product briefs graded simple, medium and hard | `simple/usb-c-breakout.md` |
| [`openspec/`](openspec/) | The specification and every planned or in-flight change | `specs/SPEC.md` |
| [`docs/`](docs/) | The public docs site (Astro Starlight), published to docs.copperhead.sh | `src/content/docs/` |

And what copperhead writes inside a target repo:

| Path | What it is |
| --- | --- |
| `docs/*.md` | The design docs, which are also the agent's memory |
| `docs/DECISIONS.md` | Append-only log with one line per decision: the date, the run id, the decision, and a `why:` with its reason |
| `docs/CHANGELOG.md` | One entry per run |
| `.copperhead/config.json` | Paths, model, turn and repair limits, budgets |
| `.copperhead/constraints.json` | Machine-readable constraints, each with a `source` and the artifacts it `affects` |
| `.copperhead/README.md` | Explains the two files above to anyone who clones the repo |
| `.copperhead/runs/<timestamp>/` | JSONL transcript plus `summary.md` for each run. Gitignored. |
| `openspec/changes/<id>/` | The proposal the agent wrote before it was allowed to edit |

## 8. The rules you must not break

These come from [`SPEC.md`](openspec/specs/SPEC.md) and [`AGENTS.md`](AGENTS.md). The invariant checklist in the PR template covers them, and reviewers check every box. Here they are with what a violation would actually look like, because the abstract version is easy to agree with and still break.

1. **Spec-gated in.** Edit tools are absent from the tool list until a proposal validates.
   *Breaks it:* adding a new mutating tool with `requiresUnlock: false`, or "helpfully" letting the model see `edit_file` with a note saying not to use it yet.

2. **Verification-gated out.** Every KiCad edit is followed by ERC, plus DRC when the board changed, before success. Persistent failure restores the snapshot.
   *Breaks it:* a code path that commits after an edit without consulting `ctx.lastErc`, or a `finish` shortcut for "small" changes.

3. **`check` stays LLM-free and network-free.** Nothing reachable from [`src/commands/check.ts`](src/commands/check.ts) may import a provider or a model SDK, or make a network call.
   *Breaks it:* importing a helper from `src/agent/loop.ts` into a module that `check` uses. That helper drags every provider into `check`'s module graph.

4. **No s-expression round-tripping.** The parser in [`src/kicad/sexp.ts`](src/kicad/sexp.ts) only reads. The agent edits KiCad files with anchored, exact-match text replacement. The few deterministic writers (board populate, `move_footprint`, the sym-lib-table rewrite) splice exact spans located by [`src/kicad/spans.ts`](src/kicad/spans.ts) and keep every other byte.
   *Breaks it:* "parse the board, change one field, serialize it back". It looks tidy and it reformats or drops things KiCad cares about.

5. **The ledger gates the commit.** Drift checks, constraint dual-writes, decisions and changelog entries are obligations, not suggestions.
   *Breaks it:* a new tool that changes docs but never calls `ledger.onDocEdit`.

6. **Secrets stay out.** Keys live only in environment variables, `.env` and `.copperhead/runs/` stay gitignored, and transcripts redact anything shaped like `sk-...` at write time ([`src/util/redact.ts`](src/util/redact.ts)).

7. **Never destroy user work.** Snapshot, rollback, the dirty-tree check and the path sandbox exist so that the worst case is a no-op. Never weaken them to make a test pass.

## 9. Making your first change

### How work is planned

We use [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven development. Anything that changes behavior starts as a change folder under [`openspec/changes/`](openspec/changes/) with a `proposal.md` (what and why), a `design.md` (decisions and trade-offs), delta specs written as WHEN/THEN scenarios, and a `tasks.md` checklist. `openspec/changes/add-part-research-tools/` is a good example to read. When spec-level behavior changes, `openspec/specs/SPEC.md` and the change artifacts move together in the same PR.

```bash
openspec status --change <change-name>
openspec validate <change-name>
```

Bug fixes and docs changes usually do not need a change folder. If you are not sure, ask in review before writing code.

### A good first task

Pick something small and deterministic: a clearer error message, a missing test for an edge case, a drift check that misreads a table. It lets you learn the test setup and the PR process without needing a model in the loop.

### Testing

```bash
npx vitest run test/ledger.test.ts   # one file while you iterate
npm run typecheck
npm test                             # the full offline suite before you push
npm run build                        # for CLI or packaging changes
npm run lint:md                      # for any markdown change; CI runs it
npm run docs:build                   # for changes to the docs site
```

Add or update a test for anything you change. If your change touches CLI behavior, the agent loop, a provider, or the KiCad layer, you also have to exercise it by hand in a `manual-tests/` sandbox and paste what you ran into the PR.

### Opening the PR

- Branch from `main`, one logical change per PR.
- The PR description template has required sections: What, Why, Testing (with the automated status table and the manual test log), Docs, and the invariant checklist. A `PR lint` check fails the PR if any of them is missing.
- Report real results only. If you did not run the live-model tests, say "skipped" and why.
- Write prose without em dashes. Use colons, commas or parentheses instead. The PR template and the docs follow this rule.
- Your first PR needs the one-time [Contributor License Agreement](.github/cla/CLA.md). A bot comments with instructions, and signing is a single PR comment.

[CONTRIBUTING.md](CONTRIBUTING.md) has the full details.

## 10. Gotchas that cost people time

- **"working tree is dirty".** `do` and `create` refuse to run on uncommitted changes, because a rollback would wipe them. Commit first, or pass `--allow-dirty` and copperhead stashes your work in the snapshot. In sandboxes, commit right after `init`: a failed run's `git clean` deletes untracked files.
- **Line endings on Windows.** With `core.autocrlf=true`, a git checkout in a sandbox rewrites KiCad files with CRLF line endings. Multi-line `edit_file` anchors then stop matching, and byte comparisons fail for no visible reason. If edits mysteriously "cannot find the anchor", check line endings first.
- **Footprints that exist but KiCad cannot see.** copperhead finds footprints in the stock install folder even when KiCad's `fp-lib-table` does not list them, but `kicad-cli` only resolves them through that table. On a fresh headless install with no global table, the board populates fine and then DRC fails with `lib_footprint_issues`. The fix is to copy KiCad's template `fp-lib-table` into your KiCad config folder. CI does exactly this (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- **Flaky timeouts in `npm test`.** The suite shells out to `kicad-cli` a lot. Running it while a long `create` run is going, or running two suites at once, causes spurious timeouts. Run it on an idle machine. A handful of tests also fail on Windows for environment reasons; compare against a clean `main` before assuming you broke them.
- **`check` passes but the board looks wrong.** The gates check text, numbers and KiCad's rules, not appearance. Look at the per-stage SVGs in `.copperhead/runs/<id>/artifacts/`.
- **`UNVERIFIED` everywhere.** That is expected. Today the agent picks parts from what it knows, and nothing checks MPNs against a datasheet yet. The planned fix is the `add-part-research-tools` change.

## 11. Glossary

| Term | Meaning |
| --- | --- |
| ASSUMED | A flag in `SPEC.md` for any requirement the brief did not state and the agent picked a default for |
| Brief | The markdown product description that `create` starts from; see [`examples/`](examples/) |
| Budget | A hard number in `.copperhead/config.json`, like `sleep_current_uA`, that every run must respect |
| Constraint registry | `.copperhead/constraints.json`; every constraint is written there and in the docs in the same turn (the "dual write") |
| Drift | A doc that disagrees with the schematic; `check` reports it and `sync` resolves it |
| Draft quality | The section of `LAYOUT.md` where stage 5 states what is fine and what a human should redo |
| Intent (IR) | `schematic.intent.json`, the JSON circuit description the drafting engine draws from |
| Ledger | The sync-obligations ledger; open items block `finish` |
| Legibility | Whether a schematic is readable: no text over symbols, sensible spacing; checked by [`src/kicad/legibility.ts`](src/kicad/legibility.ts) |
| Populate | The deterministic step that puts every schematic part on the board before stage 5 |
| Proposal | The OpenSpec change the agent writes and validates before its edit tools unlock |
| Snapshot | The git state recorded before a run; every failure restores it |
| Truth precedence | The rule `sync` follows: KiCad files are the as-built facts, specs and budgets are the requirements, and a requirement violation is reported, never silently fixed |
| UNVERIFIED | A flag on any MPN the agent chose without checking a datasheet |

## 12. What to read next

1. [`openspec/specs/SPEC.md`](openspec/specs/SPEC.md): the full specification, including the numbered acceptance criteria (AC-1.1, AC-3.4 and so on) that every feature is measured against. Long, but it is the source of truth.
2. The docs site pages on [the agent loop](docs/src/content/docs/concepts/agent-loop.md), [guardrails](docs/src/content/docs/concepts/guardrails.md) and [docs as memory](docs/src/content/docs/concepts/docs-as-memory.md).
3. [`openspec/changes/build-copperhead-phase-1/design.md`](openspec/changes/build-copperhead-phase-1/design.md): the reasoning behind the big decisions, which helps when something in the code looks odd.
4. [`AGENTS.md`](AGENTS.md): the same rules written for coding agents. If you use one on this repo, it reads that file automatically.
5. A real run log in [`pipeline-run-logs/`](pipeline-run-logs/), read alongside `loop.ts`.

If something in this guide is wrong or out of date, fix it in the same PR as the code change that made it wrong. That is the same rule copperhead enforces on the boards it designs.

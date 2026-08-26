# I gave an AI agent commit access to my KiCad repo

*A twenty-minute onboarding, and the four refusals that made it worth doing.*

---

The pitch for AI in hardware design usually arrives backwards. It leads with the impressive part (describe a board, get a schematic) and leaves the obvious question unasked: why would you let a language model near a file that turns into a physical object with a four-week lead time and a minimum order quantity?

That question deserves a real answer, because the failure mode is not a red squiggle. It is a hundred boards with a resistor on the wrong net.

So this is not a demo post. It is the first twenty minutes with [copperhead](https://copperhead.sh) on a board that already exists, written down honestly, including the parts where it stops and refuses to continue. Those turn out to be the interesting parts.

## The premise

copperhead is a CLI agent that works on a KiCad repository the way a coding agent works on a codebase. It reads your design docs, proposes a change as a validated spec, edits the real `.kicad_sch` and `.kicad_pcb` files, then runs `kicad-cli` ERC and DRC on its own work until the tools agree.

KiCad stays your editor. Nothing moves into a walled garden. The files it edits are the files you already have, in the git repo you already have, and every artifact it produces is plain text you can read in a diff: s-expressions for the schematic and board, markdown for the design docs and the reasoning behind them.

Two rules hold the whole thing up, and it is worth stating them before anything else, because everything below is a consequence of one of them:

1. **Nothing starts without a spec.** The agent cannot touch a KiCad file until a change proposal exists and validates. Not "is told not to": the edit tools are absent from the list of tools it is given until that proposal passes. An ungated edit is not something it attempts and fails at. It is not expressible.
2. **Nothing is done until the tools agree.** Every file mutation is followed by ERC, and DRC if the board changed. If verification cannot be made to pass, the run rolls back to a git snapshot taken before it started, and reports it loudly on the rare occasion that the rollback itself cannot complete.

Those are guardrails against the failure mode that actually matters. Not "the AI said something wrong": you would catch that. The one that matters is "the AI changed a net name in the schematic but not in the pinout doc, and nobody noticed for three weeks."

## Minute zero: asking what is missing

The first command is not the impressive one.

```bash
copperhead doctor
```

```text
  [ok]   node      v24.16.0 (>= 20)
  [ok]   kicad-cli 8.0.9
  [ok]   git       2.54.0.windows.1
  [FAIL] provider  no model configured
  [info] project   no .copperhead/config.json (run `copperhead init` to
                   scaffold)
not ready: fix the [FAIL] items above
```

No model, no network, no cost. It just reports what is missing, and every message names the fix.

I want to dwell on the third line for a second, because it is the one that says something about the design. `git 2.54.0` is checked with the same weight as KiCad itself, and if it were missing the tool would refuse to run. copperhead snapshots your tree with git before it edits, and rolls back to that snapshot when verification fails. No repo, no undo, no run. The safety net is not a feature: it is a prerequisite.

Then it told me to fix my own environment:

```text
  [FAIL] provider  ambiguous: multiple credentials, no model selected
         hint: 2 credentials found (OPENAI_API_KEY, ANTHROPIC_API_KEY) and no
               model was selected; pass --model, set COPPERHEAD_MODEL, or set
               "model" in .copperhead/config.json.
```

I had both keys exported, like most developers do. A more accommodating tool picks one and gets on with it. This one stops, on the grounds that quietly choosing a provider means quietly sending your design to a company you did not pick, and quietly billing you for it.

**Refusal #1, and we have not started yet.** I named the model and moved on.

## Minute five: it reads your board before it writes anything

```bash
copperhead init
```

This reads the existing schematic and scaffolds a `docs/` directory: spec, subsystems, BOM, pinout, layout notes. Those files are not documentation in the write-once sense. They are the agent's memory. Every run reads them first, which means it operates with the whole design in context instead of just the part in front of it, and it means a wrong value in there becomes a wrong assumption in every change afterward.

Which makes the next ten minutes the highest-leverage ten minutes in the process: read what it wrote about your board, and correct it. That is not overhead. That is the work.

I re-ran `init` to see what would happen, and got **refusal #2**: it will not overwrite a generated doc you have since hand-edited. It exits non-zero and names the files it skipped. Your edits win over its scaffolding, by default, permanently, unless you pass `--force`.

## Minute ten: a baseline, and a trap

```bash
copperhead check
```

ERC, DRC, doc-drift detection, constraint checks, spec validation. No LLM calls and no network access, not by convention but by contract: the module imports no provider, so it *cannot* make one. That is what makes it safe to drop into CI and into the pre-commit hook `init` installs for you.

Here is the trap, and I include it because I walked into it. Run `check` on a repo you have not `init`-ed and you get this:

```text
ERC skipped (no schematic configured; run copperhead init)
DRC skipped (no board configured)
```

Exit code: 0. Green. That is a pass over an empty set, not a clean board, the same shape as a test suite reporting success because it collected no tests. Read the lines, not the exit code.

## Minute fifteen: the actual change

I picked a net rename. Narrow, and wrong would be obvious.

```bash
copperhead do "rename net KEY_DAH to KEY_DASH" --interactive
```

It proposed first: why, what changes, the task list. Only after that validated did its edit tools come into existence at all. Then it made anchored replacements in the schematic and in every doc that mentioned the net, ran ERC, and committed once: verification result in the commit message, a line in the changelog, the reasoning appended to a decisions log.

The propagation is the part that earns its keep. Renaming a net in the schematic is thirty seconds of work. Renaming it in the schematic *and* the pinout *and* the BOM rationale *and* the subsystem description, without missing one, is the boring, error-prone task that hardware documentation dies of. That is the job it is actually good at.

## The two refusals I did not expect

**Refusal #3.** Every text edit to a schematic or board is probed for loadability afterward. If the edit would leave the file unopenable in KiCad, it is reverted immediately and the agent is handed the parser error to try again. A corrupted s-expression file does not reach your disk and then fail confusingly on the next command.

**Refusal #4** is the one that changed how I think about the tool. There is a mode where the schematic is generated from a declarative intent file (parts, nets, groups, no coordinates) and a deterministic engine computes every wire and position. In that mode, the agent is *forbidden from hand-editing the schematic it just drew*. Ask it to nudge something and it declines, and tells you to revise the intent and regenerate.

That is a system refusing to do the easy thing in the moment because the easy thing destroys a property it needs later: the same intent must always produce byte-identical output. The moment you allow one manual nudge, the drawing and the intent diverge, and you no longer know which one is the design.

I have worked with people who lacked that discipline.

## What I would tell you before you try it

**It is early, and says so.** The README leads with it. Phase 1, expect the surface to move.

**Know what each command costs.** `check`, `doctor`, and the deterministic commands are free and instant: no model involved. A small `do` is a few minutes. `create`, which goes from a product brief to gerbers and firmware across eight stages, runs in hours, not minutes. It prints a heartbeat so you can tell slow from hung. Start with a small brief.

**It is not the engineer of record.** Not an autorouter, not a replacement for your judgment, and it never claims a board is fab-ready: only that ERC and DRC are clean. A human still signs off. That framing is in the docs, unhedged, which I respect more than the alternative.

**Failed work is normally recoverable.** When a run cannot make verification pass, it rolls back, but it tries to stash everything it touched first, under a named git stash entry, and prints the command to get it back. Both steps are best-effort rather than guaranteed: if the rollback itself fails, the run says so and warns that the tree may be partial, which is your cue to read `git status` instead of assuming a clean revert.

## The part that actually matters

The demo-friendly claim about AI in hardware is that it designs the board for you. That is not the claim worth evaluating yet.

The claim worth evaluating is narrower and much more useful: that a change to a circuit can propagate through every document that references it, that the propagation is verified by the same tools you already trust, and that nothing is called done until those tools agree. Not a designer. A tireless, slightly pedantic junior engineer who has read every doc in the repo, refuses to skip the boring cross-checking step, and stops to ask when the spec and the board disagree.

Twenty minutes in, four refusals, one verified commit. The refusals were the reason I kept going.

---

**Try it:** [docs.copperhead.sh](https://docs.copperhead.sh) · [Your first run](https://docs.copperhead.sh/getting-started/first-run/) · [GitHub](https://github.com/chouhanindustries/copperhead) · Apache-2.0

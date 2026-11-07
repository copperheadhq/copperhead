---
title: Docs as memory
description: The markdown in your repo is the agent's memory, its output, and the thing verification protects.
sidebar:
  order: 3
---

copperhead has no hidden database. Its memory is the markdown in your repo, which means you can read all of it, edit all of it, and review it in a pull request like anything else.

## What `init` scaffolds

`copperhead init` reads your schematic and writes these into the docs directory (`docs/` by default):

| File | What it holds |
| --- | --- |
| `SPEC.md` | What the device is, plus top-level constraints and budgets |
| `parts.intent.json` | Parts manifest written by `create` (refdes, verified symbol, footprint, MPN, group, rationale); `BOM.md` is rendered from it |
| `BOM.md` | Bill of materials (rendered from the manifest when one exists; otherwise hand-written) |
| `PINOUT.md` | Pin assignments |
| `SUBSYSTEMS.md` | The design broken into functional blocks |
| `LAYOUT.md` | Layout intent: what has to be near what, and why |
| `DECISIONS.md` | Append-only decision log |
| `CHANGELOG.md` | Per-run narrative of how the design got here |

`DECISIONS.md` and `CHANGELOG.md` are append-only. The agent adds to them and never rewrites history.

## Budgets are constraints

Hard numbers in `SPEC.md` are not decoration. Budgets declared in `.copperhead/config.json` are surfaced verbatim into every run's system prompt, and a change that would blow one is refused rather than quietly accepted.

```json
{
  "budgets": { "sleep_current_uA": 25 }
}
```

Ask for something that costs more than the budget allows and the agent says no and explains the arithmetic, instead of shipping the change and letting you find out at bring-up.

## Drift is a build failure

Docs that disagree with the schematic are the failure mode this whole tool exists to prevent. `copperhead check` compares the two and reports every mismatch in the form "this doc claims X but the actual value is Y". Because `check` runs with no LLM and no network, you can put it in CI and in a pre-commit hook, and the hook is installed for you by `init`.

Hand edits that desync the docs, the constraint registry, or the schematic fail at commit time. See [Verify and sync](/workflows/verify-and-sync/).

<a id="copperheadreadmemd"></a>

## `README.md` in `.copperhead/`

The config directory describes itself. `init` writes a README into `.copperhead/` documenting every key in `config.json` and what `constraints.json` is for, so someone who clones the repo and has never used copperhead can still tell what these files are.

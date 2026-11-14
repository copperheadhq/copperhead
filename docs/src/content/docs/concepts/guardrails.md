---
title: Guardrails
description: The two invariants, the sync-obligations ledger, and the truth precedence that keep the design honest.
sidebar:
  order: 2
---

Everything else in the design follows from two invariants.

## Spec-gated in

The agent cannot touch a KiCad file until a validated OpenSpec proposal for the change exists. This is not a prompt asking it to behave. The `edit_file` and `write_file` tools are structurally absent from the tool list the model sees until the proposal validates, so an ungated edit is not something the model can attempt and fail at: it is not expressible.

## Verification-gated out

No file mutation counts as done until `kicad-cli` ERC passes, plus DRC if the board changed. On failure the agent reads the normalized report back and repairs, up to `maxRepairCycles` repairs that did not help (a failing check no better than the one before). If it still cannot get clean, the run rolls back to the git snapshot taken before the first edit.

Spec-gated in, verification-gated out: the design cannot drift from its requirements, because drift is a build failure.

## The sync-obligations ledger

Post-tool-call hooks feed a ledger of open obligations: a drift check that has not run, a constraint written to one place but not its counterpart, a missing `DECISIONS.md` or `CHANGELOG.md` entry. Commit refuses while any obligation is open. The agent cannot finish a run having done the interesting half of a change and skipped the bookkeeping.

## Truth precedence

[`copperhead sync`](/reference/cli/#copperhead-sync) reconciles the whole design state, and it has a fixed notion of which source wins:

- **KiCad files are as-built facts.** What the schematic and board actually say is what is true.
- **Specs and budgets are requirements.** What the design is supposed to satisfy.

When a doc disagrees with the schematic, that is drift, and the resolve phase fixes it. When the schematic violates a requirement, that is a violation, and `sync` never silently resolves it: it reports and exits non-zero, because the fix is an engineering decision, not a bookkeeping one.

## Budgets are hard constraints

Budgets declared in `.copperhead/config.json` are surfaced verbatim into every run's system prompt, and a change that would blow one is refused rather than quietly accepted. Ask for something that costs more than the budget allows and the agent says no and explains the arithmetic, instead of shipping the change and letting you find out at bring-up. See [Configuration](/reference/configuration/#budgets).

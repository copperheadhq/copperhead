---
title: Edit an existing board
description: "Flow B: one natural-language change request, one verified, committed change."
sidebar:
  order: 2
---

Flow B works on a repo that already has a schematic. If you have KiCad files already, this is your flow: run [`copperhead init`](/reference/cli/#copperhead-init) once to scaffold `docs/` from the existing schematic, then use `do`.

```bash
cd my-board
copperhead init                                    # once, scaffolds docs/
copperhead explain U1                              # optional: inspect a part, net, or pin
copperhead do "add a 100nF decoupling cap on 3V3 at U2"
```

Each `do` run is one change: propose, edit, verify, propagate, commit. The agent reads the docs first, so it knows the whole design rather than the file in front of it, and a value change carries across every doc and schematic that references it.

## Previewing and approving

Two flags are worth knowing:

```bash
copperhead do "cut sleep current to under 10uA" --dry-run      # propose, write nothing
copperhead do "fit this on 2 layers instead of 4" --interactive # approve before it writes
```

Use `--interactive` on changes where a refusal is a plausible correct answer. When a request would break a recorded budget, the run refuses with the arithmetic shown rather than quietly relaxing the budget, and that is worth watching happen.

## Where the flows meet

Both flows end in the same place: a repo where the KiCad files, the design docs, and the constraint registry all agree, and where `check` says so with no LLM in the loop.

When they stop agreeing, [`copperhead sync`](/reference/cli/#copperhead-sync) reconciles them under a fixed truth precedence: KiCad files are as-built facts, specs and budgets are requirements. Drift gets resolved, violations get reported and never auto-resolved. See [Verify and sync](/workflows/verify-and-sync/).

## Next

- [Guardrails](/concepts/guardrails/): why a run refuses, repairs, or rolls back
- [`copperhead do`](/reference/cli/#copperhead-do): all flags

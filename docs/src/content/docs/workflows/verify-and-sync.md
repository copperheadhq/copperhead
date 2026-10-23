---
title: Verify and sync
description: Keep the KiCad files, the design docs, and the constraint registry agreeing, in CI and at commit time.
sidebar:
  order: 3
---

A copperhead repo is healthy when the KiCad files, the design docs, and the constraint registry all agree. Two commands police that: `check` detects disagreement, `sync` resolves it.

## `check`: detect, deterministically

`check` (alias `verify`) runs ERC, DRC, doc-drift detection, constraint checks, and spec validation. It makes **no LLM calls and no network requests**, which is a contract, not a tendency: this is what makes it safe to run in CI and in a pre-commit hook.

```bash
copperhead check
copperhead check --spice          # also evaluate ## Simulation assertions via local ngspice
copperhead check --spice --strict # fail when ngspice is missing and assertions exist
```

It exits 0 when everything agrees and 1 when it does not. Drift is reported in the form "this doc claims X but the actual value is Y".

`--spice` is opt-in so a repo with no Simulation blocks, and CI that has not installed ngspice, keep the same `check` contract. A missing ngspice binary is a loud skip naming the unverified assertion count, never a silent pass. A `## Simulation` scope that names a sheet or net absent from the schematic fails the check.

A subsystem opts in with a block in `docs/SUBSYSTEMS.md`:

```markdown
## Simulation
scope: nets VIN, VOUT
analysis: op
source: VIN=3.3
assert: V(VOUT) between 1.6 and 1.7
```

`scope` is `sheet <path>` or `nets <a>, <b>`. `analysis` is `op`, `dc`, `ac`, or `tran`. Assertions are `V(<net>)`, `I(<refdes>)`, or `corner(<net>)` with `between a and b`, `< x`, or `> x`. Raw `.control` lines are rejected.

`init` installs a pre-commit hook that runs it, so hand edits that desync the docs, the constraint registry, or the schematic fail at commit time. In CI, add the same command as a step; with `--json` it prints a result object with per-check detail.

## `sync`: resolve, under truth precedence

`sync` has two phases: a deterministic verify phase, then an LLM resolve phase. It reconciles the design state under a fixed notion of which source wins:

- **KiCad files are as-built facts.** What the schematic and board actually say is what is true.
- **Specs and budgets are requirements.** What the design is supposed to satisfy.

```bash
copperhead sync --dry-run   # print the inconsistency report, write nothing
copperhead sync             # resolve drift
```

| Exit code | Meaning |
| --- | --- |
| `0` | Clean, or drift resolved successfully. |
| `1` | The resolve phase failed. |
| `2` | Requirement violations found. |

Exit code 2 is the important one. A requirement violation means the as-built design contradicts a stated requirement, and copperhead will **never** auto-resolve that: the fix is an engineering decision, not a bookkeeping one. Drift, where the docs disagree with the files, is resolvable and gets resolved.

## Next

- [Guardrails](/concepts/guardrails/): the invariants this workflow enforces
- [`copperhead check`](/reference/cli/#copperhead-check) and [`copperhead sync`](/reference/cli/#copperhead-sync): full flag reference

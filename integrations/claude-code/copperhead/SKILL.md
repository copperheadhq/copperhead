---
name: copperhead
description: Change or verify a KiCad project through copperhead's gated pipeline. Use whenever a task touches .kicad_sch or .kicad_pcb files, a schematic, a PCB layout, a netlist, ERC/DRC, a BOM, or hardware design docs — instead of editing those files directly.
---

# Working on a KiCad project with copperhead

This repository is a real hardware project. Its `.kicad_sch` and `.kicad_pcb` files
are s-expression files where a small textual mistake produces a board that cannot
be manufactured, and the damage is not visible in a diff.

**Do not edit `.kicad_sch`, `.kicad_pcb`, or their generated docs with your own file
tools.** Use the `copperhead_*` MCP tools. They run a pipeline that you cannot
reproduce by editing files yourself:

- the change is gated on a validated OpenSpec proposal before any edit tool exists
- every mutation is verified with real ERC, and DRC when the board changed
- a failure repairs, and then rolls the working tree back to its pre-run state
- the design docs, the constraint registry, and the decision log are kept in step

Editing the files directly bypasses all of it. A change that "looks right" in a
diff is exactly the change this pipeline exists to catch.

## Which tool

| You want to | Call |
| --- | --- |
| Change anything about the design | `copperhead_do` with the request in plain language |
| Know whether the project is currently sound | `copperhead_check` |
| Find docs/constraints that disagree with the board | `copperhead_sync` |
| Fix that drift too | `copperhead_sync` with `resolve: true` |
| Set up docs memory on a project that has none | `copperhead_init` (also installs a `pre-commit` hook running `copperhead check` — say so before calling it) |
| Work out why a tool said something was unavailable | `copperhead_doctor` |

## How to read the results

`copperhead_do` returns a status, and each one means something specific:

- **`committed`** — the change passed verification and was committed. Report the
  commit and the files touched.
- **`rolled_back`** — verification could not be satisfied, so the tree was restored.
  **This is not an error and not your failure to handle.** Nothing is broken. Read
  the transcript path in the result, tell the user what could not be satisfied, and
  ask before trying a different approach. Do not retry the same request verbatim,
  and do not attempt the edit by hand instead.
- **`refused`** — the pipeline declined the request. Relay the reason; it is usually
  a budget or a constraint the request violates, and the user needs to decide.
- **`dry_run`** — the change was proposed and nothing was written.

`copperhead_check` returning violations is information, not a failure to work
around. Surface it.

If any tool returns an `unavailable` error, call `copperhead_doctor` before
concluding anything: it reports whether node, kicad-cli, git, openspec and the
model credential are actually present, and it works even when they are not.

## Before a large or risky change

Run `copperhead_do` with `dry_run: true` first and show the user what it proposes.

## What this skill does not cover

These tools operate on one repository, configured when the server started. They
cannot edit arbitrary paths, run raw KiCad commands, or drive part of the loop —
by design. If a task needs something outside the pipeline, say so rather than
reaching for your own file tools on the KiCad files.

**The MCP surface is experimental.** Tool names, inputs, and result shapes may
change between copperhead releases.

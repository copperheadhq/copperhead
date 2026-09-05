---
title: Design from a brief
description: "Flow A: from a markdown product brief to a full, verified design package."
sidebar:
  order: 1
---

Flow A starts from nothing but a product brief and an empty git repo, and ends with a full design package. Underneath, it is [the same loop](/concepts/agent-loop/) as editing an existing board, run once per pipeline stage with a stage-specific prompt and gate.

## 1. Write the brief

The brief is a plain markdown file. This is the entire input to the pipeline, so it is worth ten minutes. Save it as `brief.md`:

```markdown
# Brief: USB-C power breakout

## What it is

A small breakout board that takes USB-C 5V from a normal charger and
presents it on screw terminals and a 0.1" header, for powering
breadboard projects. No data lines, no negotiation beyond default 5V.

## Must do

1. Accept a USB-C receptacle, sink side, 5V only.
2. Present 5V and GND on a 2-pin 3.5mm screw terminal and a 2x2 header.
3. Present itself as a plain 5V sink so a USB-C source turns on VBUS.
4. Show a power LED.
5. Protect against a short on the output.

## Budgets

- Output current: rated for 3A continuous.
- Input voltage: 5V nominal, survive 6V.
- Quiescent current with no load: under 2mA including the LED.
- Board area: 30mm x 20mm or smaller.

## Constraints

- 2-layer, 1oz copper, standard JLCPCB process, no controlled impedance.
- Hand-solderable: nothing finer than 0603, no BGA, no QFN thermal pad.
- Target BOM cost under $3 at qty 100.

## Out of scope

- USB-PD or any voltage other than 5V.
- Data pass-through.
```

Five headings do the work:

- **What it is**: one paragraph, plain language.
- **Must do**: numbered functional requirements.
- **Budgets**: numbers with units. These become recorded constraints, and later changes that break one get refused rather than accepted and discovered at bring-up. Put the unit in the name, as in `sleep_current_uA`.
- **Constraints**: form factor, cost ceiling, process limits, parts you already own.
- **Out of scope**: what not to build. Worth more than it looks.

Anything you leave out, the agent picks a default and flags it `ASSUMED` in `docs/SPEC.md`. Read those flags early: correcting an assumption before the schematic stage is much cheaper than after layout.

Six ready-made briefs ship in [`examples/`](https://github.com/copperheadhq/copperhead/tree/main/examples), graded by how much the agent has to hold in its head at once.

## 2. Run the pipeline

```bash
mkdir usb-c-breakout && cd usb-c-breakout
git init && git commit --allow-empty -m "baseline"
copperhead create --brief ../brief.md
```

The empty baseline commit matters: rollback snapshots need somewhere to roll back to.

## 3. What runs

Eight stages, each one a full `do` loop with its own prompt and gate. A stage that does not pass its gate stops the pipeline.

| Stage | Produces |
| --- | --- |
| 1. Spec | `docs/SPEC.md`, every budget also recorded as a constraint |
| 2. Architecture | `docs/SUBSYSTEMS.md`, one section per subsystem with reasoning |
| 3. Parts | `docs/BOM.md`, MPNs flagged `UNVERIFIED` with justification |
| 4. Schematic | The `.kicad_sch`, sheet by sheet, ERC clean after each |
| 5. Layout | First-draft placement and critical routing, DRC clean |
| 6. Outputs | `outputs/`: gerbers, drill, DXF, STEP, SVG, `BOM.csv` |
| 7. Firmware | `firmware/` scaffold with `pins.h` generated from `PINOUT.md` |
| 8. Dev plan | `docs/DEVPLAN.md`: bring-up order, test points, risks |

The pipeline is resumable. Stage completion is inferred from repo state, so if a stage fails, fix what it complained about and rerun the same command: it skips past what is already done and picks up at the first incomplete stage.

Stage 5 writes a `## Draft quality` section into `LAYOUT.md` saying exactly what is fine and what a human or a specialist tool should redo. Non-optimal is acceptable; unlabeled non-optimal is not.

## 4. Read the output

```bash
copperhead check   # ERC, DRC, drift, constraints. No LLM, no network.
```

Then read `docs/DECISIONS.md` for what was decided and why, and `docs/SPEC.md` for anything flagged `ASSUMED`.

## Next

- [Edit an existing board](/workflows/edit-existing-board/): every change after the first
- [Simple demo](/getting-started/demo/): this flow end to end, one command
- [`copperhead create`](/reference/cli/#copperhead-create): flags and stage reference

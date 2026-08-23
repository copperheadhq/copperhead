---
title: How schematics are drafted
description: The deterministic drafting engine, the rules it follows, and how a netlist intent becomes a placed, wired, readable sheet.
sidebar:
  order: 4
---

:::note
Specified by the `deterministic-schematic-drafting` OpenSpec change. This page explains the inner workings; the rules the finished sheet must satisfy are defined in [Schematic legibility rules](/reference/schematic-legibility/).
:::

copperhead does not ask the model to draw. During `create`'s schematic stage the model authors an *intent*: which parts exist, which pins connect, and which subsystem each part belongs to. A deterministic engine then computes every coordinate, wire, and label on the sheet. The same intent always produces the same sheet, byte for byte, on any machine.

This split exists for three reasons. Placement chosen token by token drifts from run to run and reads like it. The geometry text is where the token cost and the mid-turn failures concentrate. And a rule engine can be held to a standard mechanically: the legibility checker and the score run against its output on every change, so drawing quality is a regression test, not a hope.

## The pipeline

```text
schematic.intent.json          (model writes this: parts, nets, groups, hints)
        |
   validate      unknown symbol, missing pin, ungrouped part: stop here,
        |        numbered findings, nothing written
   reduce        power rails and ground become per-pin symbols;
        |        decoupling caps row up beside their IC;
        |        connectors go to the sheet edges
   lay out       subsystem groups tile left to right along signal flow,
        |        each sized from the symbols it must hold
   place         inside each group: columns by signal depth,
        |        ordered to keep connected pins near each other,
        |        every coordinate an integer grid step
   wire          short local connections get real wires;
        |        everything else gets a net label
   emit          canonical .kicad_sch text, stable UUIDs,
        |        library symbols copied verbatim
        v
   .kicad_sch    then: ERC, the legibility checker, and the score
```

## The intent file

`schematic.intent.json`, versioned, living beside the schematic:

```json
{
  "version": 1,
  "parts": [
    { "ref": "U1", "libId": "CopperMCU:MCU8", "value": "MCU8",
      "footprint": "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", "group": "MCU" }
  ],
  "nets": [
    { "name": "VCC", "pins": ["J1.1", "U1.1", "C1.1"] },
    { "name": "DIV", "pins": ["R1.2", "R2.1", "U1.3"], "kind": "signal" }
  ],
  "noConnect": ["U1.4", "U1.5"],
  "hints": { "groupOrder": ["Power", "MCU"], "paper": "A4", "date": "2026-07-31" }
}
```

Every part names its subsystem group (a SUBSYSTEMS.md heading) and is cross-checked against BOM.md at validation, so a transcription slip dies before anything is drawn. `kind` overrides the automatic power-net recognition when the inference is wrong; the draft report always lists every net's resolved class. `hints.date` fills the title block: it belongs to the intent, not the wall clock, so the same intent emits the same bytes on any day. The full field-by-field specification, including every validation rule and refusal, is on [The schematic intent file](/reference/schematic-intent/).

## What the model controls, and what it cannot

The intent file (`schematic.intent.json`) carries parts (library id, refdes, value), connections (net name to a list of `refdes.pin` endpoints), one subsystem group per part taken from SUBSYSTEMS.md, and optional hints: port direction, group ordering, paper size. It contains no coordinates, and the engine ignores none of its rules in favor of a hint.

When a gate objects (ERC, a legibility finding, a low score), the fix is a revised intent and a re-draft. The agent's file-editing tools refuse to touch an engine-drafted schematic, because a hand edit would be destroyed by the next re-draft. Hand-drawn schematics in existing repos are never touched by the engine; `copperhead do` edits them exactly as before.

## The drafting rules

The engine follows the conventions a careful human drafter uses, applied in a fixed order.

**Power is never routed.** A net is classified as a rail or ground by a deterministic rule (it touches a pin whose library type is power-in or power-out, or the intent declares it; the declaration wins, and the draft report lists every net's resolved class). Classified nets are removed from the wiring problem before layout: every pin they reached gets its own power-port symbol, rails pointing up, grounds pointing down, at uniform heights. A twelve-pin ground net becomes twelve small ground symbols, not a wire tree across the sheet. A rail with no power-output driver gets one synthesized `PWR_FLAG`, and pins the intent declares unconnected get `no_connect` markers, so ERC passes on drafted output without hand intervention.

**Decoupling capacitors stay with their IC.** A two-pin capacitor between a rail and ground is classified as decoupling and placed in a row beside the IC that shares its nets, with a rail label, the way a reviewer expects to find it.

**Connectors sit at the edges.** Parts classified as connectors are assigned to the left or right sheet edge, matching the direction hint if one is given (inputs left, outputs right).

**Groups tile the sheet.** Each subsystem from SUBSYSTEMS.md becomes one captioned box. Groups are ordered left to right along signal flow (sources toward the left, loads toward the right) and sized from the summed body boxes of their symbols plus clearance, so the sheet fills the frame instead of crowding one corner.

**Placement inside a group is layered.** Symbols are assigned to columns by their depth in the signal chain (longest-path layering), then ordered within each column to sit near the symbols they connect to (barycenter ordering). All arithmetic happens in integer multiples of the 1.27mm grid, so every pin lands on-grid by construction rather than by rounding.

**Wires are local or they are labels.** A real wire is drawn only for a net that stays inside one group, touches at most four pins, and fits a distance budget: a voltage divider's tap or a crystal with its load caps gets drawn wires with junction dots, the way a person would draw it. Wires run only inside channels reserved between placement columns, so they can never cross a symbol body. Every other connection, including everything that crosses a group boundary, becomes a matched pair of net labels, horizontal wherever a horizontal label fits. This is how dense professional schematics are drawn, and it is why the engine does not need a general-purpose autorouter.

**Text never fights the drawing.** Reference and value text slots are computed with the symbol placement, so labels cannot land on a neighbour's body or wire.

**The sheet is aligned and balanced, not merely legal.** Column placement provides the baseline (shared column axes, uniform sibling spacing in decoupling rows, centered groups, a balanced page), and two idiom passes then redraw the small structures a human drafts by reflex. A maximal run of two-lead vertical parts linked by two-endpoint nets (a pull-up on its pin, a series RC to ground, a divider between rails) is restacked as one straight vertical line on its anchor pin's stub axis, uniform gaps, rail or ground symbol at the free end, so its wires run dead straight; a crystal's load capacitors drop below the crystal's own pins, which places them mirror-symmetric at equal offsets by construction. Both passes are strictly conservative: a move is refused outright if any body, any visible text slot, the growth of a power symbol, or any foreign pin or stub end on the run's axis would be disturbed, because a chain routed down a column of neighbouring stub ends would silently merge nets, which is worse than a less pretty column. Symmetry and alignment stay computed properties, and the score measures them (axis alignment, spacing uniformity, straight-wire ratio, whitespace balance, pair symmetry) so an update that makes sheets uglier fails its benchmark even when every hard rule still passes.

**The title block is filled** from the project configuration: title, revision, date.

## Determinism

Determinism is structural, not best-effort. The engine uses no randomness, no clock, and no environment-dependent ordering. Every UUID in the emitted file is derived (UUIDv5) from a stable semantic path such as `sheet/U1/pin/7`, elements are emitted in a canonical order, and library symbol definitions are copied byte-for-byte from `.kicad_sym` sources vendored into the project on first use, so upgrading KiCad's libraries cannot silently change your sheet (`verify_symbols` still tells you when the installed library has moved on). Re-drafting an unchanged intent therefore produces a byte-identical file and an empty git diff; changing one net touches only the elements that net affects. One caveat: the guarantee holds for sheets copperhead owns end to end. Once a sheet is re-saved by hand in KiCad, KiCad rewrites formatting and identifiers.

## How quality is kept honest

Three instruments run against every drafted sheet, and none of them is the engine grading its own homework:

- **ERC** (via `kicad-cli`) checks the electrical facts, as it always has.
- **The legibility checker** evaluates the [thirteen check families](/reference/schematic-legibility/) read-only. Error-severity findings block the schematic stage from completing.
- **The score** (`copperhead score schematic`) measures the judgment calls: wire crossings and bends, total wire length, alignment, page utilization, label-to-wire ratio, group cohesion, and flow direction, combined into a weighted 0-100 composite whose per-metric breakdown is always printed. Any error-severity finding caps the composite, so a good number can never hide a real defect.

Behind these sits a golden corpus in CI: known-good hand-drawn sheets that must stay finding-free and above a score floor (catching checker false positives), known-bad sheets that must keep producing their exact findings (catching detection regressions), and reference intents whose drafted output is pinned byte-for-byte with its score (catching engine regressions). Goldens change only through an explicit update flag, and the resulting diff is reviewed like any other code change.

## Trying it

```bash
copperhead draft schematic   # intent in, schematic out; deterministic, offline
copperhead score schematic   # score JSON for the configured schematic
copperhead check   # ERC plus legibility findings and score, advisory, exit code unchanged
```

All three are LLM-free and network-free, safe for CI and pre-commit hooks.

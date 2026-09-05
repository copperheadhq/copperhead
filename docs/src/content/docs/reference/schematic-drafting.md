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

**Wires are local or they are labels.** A real wire is drawn only for a net that stays inside one group, touches at most four pins, and fits a distance budget: a voltage divider's tap or a crystal with its load caps gets drawn wires with junction dots, the way a person would draw it. Wires run only inside channels reserved between placement columns, so they can never cross a symbol body. Every other connection, including everything that crosses a group boundary, becomes a matched pair of global-label flags at the ends of short stubs, each flag continuing its stub's direction (a leftward pin reads leftward, an upward one upward) and shaped by the pin it serves: an output pin's net leaves through an output flag, an input's arrives through an input flag, a bidirectional pin's points both ways, and a passive part's is a plain box. This is how dense professional schematics are drawn, and it is why the engine does not need a general-purpose autorouter.

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

## Pin-anchored hangs

A drafter puts a part on the pin it serves: the compensation network hangs off COMP, the bootstrap capacitor sits on BOOT, a pull-up rises from the pin it pulls. Before any column is packed, the engine reads each IC's side pins in order and claims the chain of vertical two-lead parts a pin's net leads into as a **hang**: entered through the part's top lead it drops below the pin's row, through its bottom lead it rises above it, and it runs on through two-endpoint links until it reaches a rail, a ground, a tapped node or a part that cannot hang. Every hangable endpoint of the pin's net hangs, each as its own chain, so a series RC and a shunt C on one pin both sit at that pin and the net stays within wire span.

A hang whose rows are free of every other connected signal pin on that side stays dead straight on the stub axis (the wire from the pin continues into the chain with no bend); otherwise it takes the first shelf slot beside the IC whose rows are free, past the IC's own labels. Slots are dealt from the lowest pin upward for hangs that drop and from the highest pin downward for hangs that rise, so a chain that passes other pins' rows is always the outer one and no branch crosses a sibling. The IC's cell reserves the shelf, so the columns start past it, and the box encloses everything.

Each hang goes through the same clearance check every idiom uses, with the chain's own connection points taken from the nets that run along its axis only, never the rail at its far end. A hang the check refuses is drawn in a column at the group's right edge and named in the draft report's notes as `hang refused: …`, so a labelled part is never a silent fallback. Crystal load capacitors are left to the crystal-flanking idiom, and decoupling capacitors stay in their bank.

Measured with the wiring-style score (see the legibility page): on the reference boards the share of two-pin parts wired straight to another part rose from 0.26 to 0.48 on buck-12v-5v and from 0.53 to 0.59 on usb-atmega-node; on a 141-part amplifier board from 0.49 to 0.57, and on the five-part Tier C golden from 0.00 to 0.67. What remains unattached is horizontal-pinned parts (diodes, LEDs, fuses, two-pin connectors, switches), which need symbol rotation, and parts whose net leaves the group.

## Series parts on the row, and rotation

A part whose run from the IC pin ends on a signal net rather than a rail or ground is a **series element** — a 100 Ω in an I2S line, an output inductor, a bootstrap capacitor between two pins of the same IC — and lies along the pin's row, away from the IC, the way a drafter draws it. The engine turns the symbol for that: a resistor from the library is vertical and lies down at 90 or 270 degrees so its near lead faces the IC, while a diode, LED, fuse or switch is horizontal already and turns only to face the right way. The same orientation rule lets those horizontal parts hang like a resistor when their run ends on a rail or ground. Each part sits one gap past the previous connection point, and the gap is at least the width of the wired net's name, so the name stands above the wire in the space left for it. Runs on rows one pitch apart start past each other's end, because two horizontal parts cannot share an x range on neighbouring rows. A run that cannot be laid on its row is drawn in a column and reported as `inline refused: …`.

## Local runs are wired

The wire pass no longer decides a net whole. Its endpoints are clustered by group and wire span, and every cluster that routes cleanly is drawn as one wired run with one label, whatever the rest of the net does; a cluster that will not route whole is drawn as its largest routable subset, and only the endpoints left over keep a stub and a label. So a part hung on a pin or lying on its row is wired to it even when the net also leaves the group or carries more endpoints than one run may hold. A run's name goes at the top of its trunk, or at the left end of a horizontal run, wherever it clears every body. A net wired whole carries that name as a plain local label standing on the wire; a net that also leaves its run through a stub is named by global flags there, so the run's name becomes a flag too (a local and a global label of one name do not connect in KiCad), reading along the row from a wire end; where no horizontal flag fits anywhere on the run, every label of the net becomes a plain local label instead.

## Everything on its pin

The third placement pass closes the gap between "most parts on their pins" and all of them. On the ESP32 amplifier engagement sheet it took two-lead parts wired to another part from 68 % to 100 % with no legibility error, at the cost of fourteen wire crossings where combs of rising and dropping parts on adjacent pins cross one another.

**Lanes, one T per pin.** The parts hung on one pin share one axis: a pull-up rising and a pull-down dropping from the same pin meet its row in a single junction, the divider a drafter draws. Pins on one side of an IC take lanes outward from the stub, and a lane's occupied range runs from its pin's row to the chain's end, so a chain rising from a lower pin never shares a lane with a higher pin's drop. Every chain on a side starts level: drops below the side's lowest hung pin row, rises above its highest, so a chain from one pin never puts its body across the next pin's row. The row wire runs from the stub out to the lane and the chain meets it there; where a row must cross another lane's wire it crosses it, a crossing the score counts and the trace names. A hung part is wired to its pin whatever the lane's distance, so a fourth lane past the wire span still belongs to its pin. The gap from a row to the first hung part is three grid units, an odd count, so a hung part's stub end sits between pin rows rather than on the neighbouring one.

**Lanes before runs.** A part lying on a pin's row starts past the pin's lanes, so the row reaches the hung parts before the series part (a transistor on the row no longer blocks the pull-down beside it).

**Connectors and switches anchor too.** After the ICs, every connector and switch in the group claims the parts on its pins the same way: a fuse rises from the jack's pin to its fused rail, a button's series resistor lies on the switch's row. A switch already hung on an IC pin anchors nothing.

**A run may end in a transistor.** A series resistor into a base or gate ends the run with the transistor, mirrored left-for-right when needed so the base faces the part that drives it, collector up and emitter down; a transistor driven straight from the pin lies on the row the same way. Its other pins take what the wire pass gives them: a ground stub, a label, or a part stacked on the collector by the chain pass, which now turns a part half a turn when the lead that meets its anchor is the wrong one.

**The far end of a run is a node.** Shunts on the net past a series part hang from the run's last part: an RC filter's cap drops straight from the row's end, a button's debounce cap and ESD diode take lanes past it.

**Text.** A turned part stores its field angle the way KiCad does (90 on a part turned 90 or 270), so its reference and value read horizontally; the checker measures property text at its drawn angle. Every text clearance check pads the candidate by 0.8 mm, so two texts that merely touched no longer read as one word. An IC's name goes inside its body only when the pin names leave four text heights of room around it and the symbol draws no text of its own; a rail bar, a ground symbol and the part's own pin lines are obstacles to its fields like any body. A run's flag reads along the row; where no horizontal flag fits anywhere on the run, the whole net is named by plain labels instead, which KiCad connects across the sheet just the same. A flag on a vertical stub reads horizontally when nothing stands there.

**Boxes never intersect.** After the sheet is drawn, any two group boxes that intersect widen the right-hand group's tiling reserve by the overlap and the sheet is drafted again, at most three times; placement is a pure function of the intent and these reserves.

`COPPERHEAD_DRAFT_TRACE=1` prints every one of these decisions: what each pin claimed and why a part was skipped, each lane's position, each refused hang or run, every label that could not be placed where it stood and where it went, and every wire crossing by net.

## Conventions the sheet follows

The target the engine draws toward, collected from practitioner guides, a hand-drawn reference board and the KiStack schematic skill's checklist, re-expressed here. Where a rule is the engine's, it is enforced by construction and gated; where it is the intent's, the stage prompt asks for it.

| Convention | Whose | How |
| --- | --- | --- |
| Signals flow left to right; the IC leads its group; connectors on the left | engine | IC-first layering, connector column |
| A part sits on the pin it serves: shunts hang in lanes, one junction per pin, series parts lie on the row, test points rise beside their net; connectors and switches anchor their parts too | engine | pin-anchored hangs, lanes with level bases, inline runs, node hangs |
| A transistor sits at the end of the run that drives it, base to the driver, collector up | engine | mirrored inline runs |
| No two-pin part is left as a labelled island | engine | hangs, runs, node hangs, chain pass; gated on the reference boards |
| Wire what is local, label what is not; one label per wired run | engine | cluster-first routing |
| Rails and grounds are symbols, rails up and grounds down, one per bank of caps | engine | power pass, bank trunks |
| Decoupling in banks with shared symbols; a PWR_FLAG at each undriven rail's first endpoint | engine | bank idiom, flag synthesis |
| Every part carries a reference and a value that collide with nothing, 0.8 mm of air between texts; all text horizontal, on turned parts too | engine | field slot ladder, text padding, KiCad field angle |
| Related nets coloured together: rails, grounds, and every family of signals sharing a prefix; lone signals in the theme default | engine | wire and label colour |
| Subsystems as captioned boxes that enclose their own text; page sized to content; boxes compact | engine | group rects, enclosure, compaction |
| Bus and interface nets share a prefix; differential pairs end in +/- or P/N; values carry units | intent | stage prompt |
| Notes, datasheet references and design intent on the sheet | not yet | needs a notes field in the intent |

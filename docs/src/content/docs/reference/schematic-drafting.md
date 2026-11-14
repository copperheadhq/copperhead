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

**Lanes, one T per pin.** The parts hung on one pin share one axis: a pull-up rising and a pull-down dropping from the same pin meet its row in a single junction, the divider a drafter draws. Pins on one side of an IC take lanes outward from the stub, and a lane's occupied range runs from its pin's row to the chain's end, so a chain rising from a lower pin never shares a lane with a higher pin's drop. Every chain on a side starts level: drops below the side's lowest hung pin row, rises above its highest, so a chain from one pin never puts its body across the next pin's row. The row wire runs from the stub out to the lane and the chain meets it there; where a row must cross another lane's wire it crosses it, a crossing the score counts and the trace names. A hung part is wired to its pin whatever the lane's distance, so a fourth lane past the wire span still belongs to its pin, and however many parts hang there: a run of more than four endpoints is narrowed to the pin and the parts hung on it before it is routed, and the rest of the net keeps its labels. The gap from a row to the first hung part is three grid units, an odd count, so a hung part's stub end sits between pin rows rather than on the neighbouring one.

**Lanes before runs.** A part lying on a pin's row starts past the pin's lanes, so the row reaches the hung parts before the series part (a transistor on the row no longer blocks the pull-down beside it).

**Connectors and switches anchor too.** After the ICs, every connector and switch in the group claims the parts on its pins the same way: a fuse rises from the jack's pin to its fused rail, a button's series resistor lies on the switch's row. A switch already hung on an IC pin anchors nothing.

**A run may end in a transistor.** A series resistor into a base or gate ends the run with the transistor, mirrored left-for-right when needed so the base faces the part that drives it, collector up and emitter down; a transistor driven straight from the pin lies on the row the same way. Its other pins take what the wire pass gives them: a ground stub, a label, or a part stacked on the collector by the chain pass, which now turns a part half a turn when the lead that meets its anchor is the wrong one.

**The far end of a run is a node.** Shunts on the net past a series part hang from the run's last part: an RC filter's cap drops straight from the row's end, a button's debounce cap and ESD diode take lanes past it.

**Text.** A turned part stores its field angle the way KiCad does (90 on a part turned 90 or 270), so its reference and value read horizontally; the checker measures property text at its drawn angle. Every clearance check that places a label or a field pads the candidate by 0.8 mm, and so does the final sweep that settles power-symbol values, so two texts that merely touched no longer read as one word. The one relaxation is a wired run's label with no padded point anywhere on its run, which takes a quarter pad and then touching rather than sit on a body. An IC's name goes inside its body only when the pin names leave four text heights of room around it and the symbol draws no text of its own; a rail bar, a ground symbol and the part's own pin lines are obstacles to its fields like any body. A run's flag reads along the row; where no horizontal flag fits anywhere on the run, the whole net is named by plain labels instead, which KiCad connects across the sheet just the same. A flag on a vertical stub reads horizontally when nothing stands there.

**Denser cells, better rows.** Cell margins are four grid units, channels six and row gaps three (down from six, eight and four), which took the engagement sheet's group boxes from 228 k to 214 k mm². The shelf-wrap still keeps declared order, but chooses which consecutive groups share a row to minimise the stack's height instead of filling each row until the next group no longer fits (first-fit stacked five rows where four would do). The compaction pass tries height budgets down to a quarter of the sheet, so a tall group's columns re-row side by side for a small sheet. A plain label's box stands on its line, as the checker measures it. Where a sheet still does not fit, the draft report's `misses` say by how much; on the engagement sheet A2 misses because seven groups of about 200 × 100 mm need over 89 % of A2's usable area in order-preserving rows.

**Fitting the page.** Three more rules came from comparing the engine's A1 sheet with the same circuit a person re-laid on A2. The shelf-wrap tries columns as well as rows: groups keep their declared order but may fill top-to-bottom then left-to-right, so groups of like width stack in one column (three at 250 mm, three at 205 mm, the rails alone). The title block is a corner, not a strip: a column may run down to the frame when the boxes reaching into the strip stay clear of the block itself. Under a band budget a group is shaped to fill its band in one pass rather than to be square, at the lowest column height whose columns fit side by side (eight test points as two columns of four, five button blocks as three and two), and the lanes beside an anchor start at the reach of the labels that are actually drawn on that side, not of every pin's possible label. The compaction pass tries band budgets of a half, two fifths and a third of the sheet with each height budget. On the engagement sheet this took the group boxes to 208 k mm² and still misses A2: three columns of 242, 208 and 112 mm need 578 mm against 574, and the UI grid stands 145 mm tall where the hand layout is 93, because a hung part's cell reserves a full hang gap, part, power symbol and two margins.

**The squeeze.** The first draft sizes every cell by rule: a margin a side, a power symbol's worth under every hung part, a label beside every pin. It then draws into that room. Each further round measures what every cell actually drew (its body, its fields, and the wires, labels and power symbols of the runs on its pins, with everything hung on it rolled up into it), sizes the cells from those measurements plus one grid unit of pad at a two-unit margin, and draws again. Runs shared by several independent cells (a bank's rail and ground trunks) give each cell only the wires touching its own pins. A round is kept only when the group boxes shrink by more than three percent, no more hung parts were refused than in the kept draft, the sheet did not grow, no nets merged and the label-overlap budget held; at most three rounds. The measurement and the report (`sheetFit.squeeze`: rounds, box area before and after) are always made; the rounds themselves run when `COPPERHEAD_DRAFT_SQUEEZE=1` is set, because on the boards drafted so far the rules were already within a few percent of the drawing, each round costs a full draft, and the rounds moved the small fixtures' banks and notes enough to re-pin every reference. The note `cells measured:` names a kept round. On the engagement sheet the rules were already within a few percent of the drawing, so the squeeze kept the first round; it exists for the boards where they are not, and it is the frame for the next work on this sheet, which is structural: the UI group as a grid without a band budget, and the height of a hung part's cell.

**Shape and margins, sixth pass.** A group with no IC to lead it (buttons, test points, LEDs) is shaped no wider than two and a half times its square side, under any budget, so five button blocks and eight test points draw as a grid rather than a strip (the engagement sheet's UI group went from 366 × 150 to 262 × 123 mm). Rows are tighter than columns: the vertical cell margin is two units, and a pin that faces up or down with a rail or ground on it reserves the symbol's reach instead of a blanket margin; a hung part's chain ends with the symbol's own room plus two units, not a full margin; the power symbol's reserve is five units. Channels between columns and the gap between groups are four units. The label-extent estimate that spaces groups and columns skips the flag for a pin whose net stays inside the group, fits one wired run, and ends otherwise only in two-lead parts or test points: those hang on the pin and are wired by construction. A net to another IC keeps its reserve, since two ICs may sit past wire span and take labels. (Fitting the wrap on the boxes alone, without those reserves, was tried and put a banded group's labels outside the frame; the reserves stay.) Together with the earlier passes these took the group boxes from 228 k to about 170 k mm². The sheet stays A1 by 24 mm: the one three-row split under A2's height with the title corner (power, PD and rails on one row) is 598 mm wide against 574, and three columns come to about 600. The next 24 mm are the lane pitch beside an IC (11 mm where a drafter uses 10) and a decoupling bank that wraps to a second row when the group is width-bound.

**Balanced splits.** When a column is re-rowed into k chunks, the split is the one of k consecutive runs that minimises the tallest chunk, found exactly; a greedy fill to an equal target fell seven and one on eight test points of two heights, and the group kept the height of the unsplit column. Only when even that tallest chunk exceeds the budget does the splitter fill to the budget instead. Two things tried against the hand-laid sheet and put back: hanging a bootstrap cap in a lane toward the other pin (four attachments lost, crossings doubled, because the other row's run had to reach the lane through the comb), and fitting the wrap on box widths alone (labels outside the frame on a banded group).

**Group by group against a hand layout, seventh pass.** Measured by empty vertical bands the engine's groups waste almost nothing; their width is in the length of runs. Four rules closed most of the remaining gap to the hand-laid sheet. A hung part's lane is one unit narrower. A bridge cap (BST to SW) shares the lane of a pin that already has a hang, dropping or rising toward the other pin's row, and that row reaches its far lead with a hook: along the row past the cap, a turn to the lead's level, and back to the stub end (the router's third candidate shape, for two-stub clusters whose straight drop would cross the part's other lead); hung alone in a lane of its own it cost attachments, so it stays on the row when the pin has no lane. Shelf infill: the shelf beside an IC is as deep as its tallest lane but the lanes hang from the top pins, so a substantial cell (four pins or more, no lanes of its own, not a connector) from another column moves into the room below them, and the column it leaves narrows or disappears (the USB ESD array under the UART bridge's transistor runs). A decoupling bank orders its caps by rail and wraps before a rail whose caps would not all fit the row, so one rail's caps share one trunk. On the engagement sheet: rails 112 to 92 mm, UART 178 to 134, boxes 169 k to 161 k mm² against the hand layout's 166 k.

**The page a person lays, eighth pass.** Two things still kept the engagement sheet on A1 when its boxes were already smaller than the hand-laid A2 version's. The first was the fit's own arithmetic: a wrap is fitted before any label is drawn, so it reserves a label's width beside every pin that might take one, and on this sheet that put 130 mm of reserve on columns whose boxes then grew by nothing. The engine now looks once: a wrapped sheet is drafted again with each group's reach set to what its box was actually measured to grow past its cells (plus a unit), and that draft is kept when it fits the same or a smaller sheet with the gates holding (`sheetFit.look`). The second was the wrap's shape. Rows in declared order hold a whole row open at the height of its tallest group; columns in declared order cannot put the third group under the first. A person deals the groups to columns and lets each column stack its own: power, amplifier and UI down the first, PD, MCU and UART down the second, rails alone in the third. The masonry fit does that for two to four columns, judging the deals that keep declared order within a column and open columns in reading order (301 for seven groups in three columns, 611 501 for twelve in four) and keeping the narrowest that fits the height. The deals are searched as a tree that drops a branch as soon as a column is too tall or the columns so far are already wider than the best deal, which keeps the deal trying them all would keep; a twelve-group board drafts in under half a second again, where enumerating took nineteen. Rows, then columns, then masonry are tried on every sheet, smallest first. The engagement sheet now drafts on A2 in three rows, 110 of 110 two-lead parts wired, no text overlapping, boxes 162 k mm² against the hand layout's 166 k.

**One gap, one band.** The boxes grow to their text after the wrap has spaced their cells, each by its own text, so two boxes came to nearly touch where two others stood 10 mm apart, and a row's boxes started at three different heights. After the boxes have grown and aligned, every box moves with everything drawn in it so that neighbours along and across the lines of the wrap stand exactly four units (5.08 mm) apart, boxes of a row share their top and boxes of a column their left. Each drawn item belongs to one group, decided once before anything moves: wires, labels, junctions, no-connects and power symbols to the group of the pins on their run, anything unwired to the box it lies in. The caption is a band across the whole top of the box, not a corner the parts may rise into: nothing drawn starts above the caption's bottom plus a unit of air, whatever its column. The look measures the box's growth above and below its cells as well as beside them, and a measured round's rects carry it, so the fit stacks boxes rather than cells and the gap it fits is the gap that is drawn.

**Tight boxes on a sheet grid.** Each box is drawn around exactly what it holds: part bodies and pins with their no-connect crosses, reference and value fields, power symbols, labels and wires. It gets two grid units (2.54 mm) beside and below the content, and above it the caption band: the caption's 2 mm inset, every caption line and two units of air. Every edge lies on the 1.27 mm grid, so a box and its content move together by whole units and the padding is exactly what was drawn. When the wrap makes rows and every column's boxes are within eight units of the column's widest, the boxes form a grid: every column takes its widest box's width and every row its tallest box's height, so left edges line up down the sheet and tops across it, four units apart. A column holding one box far wider than the rest would open a gap beside the narrow ones, so there each row packs its own boxes and shares only its top; the same happens when the shared widths would leave the frame or reach the title block's corner. Neighbours always stand four units apart: a row that would then run past the frame is not squeezed (closing its gaps made a crowded row read as one block); the frame shrinks by the overflow and the sheet is tiled again, re-wrapped or on a larger sheet. A column of the columns or masonry wrap shares its left edge and stacks its boxes at their own heights. A caption wider than the parts sets the box's width, and then the parts take the middle of it, so the padding either side stays equal.

**Boxes latch on to their neighbours.** A box then reaches for its cell of the layout the way a flex or grid item stretches: toward its row's height, its column's width, and, as the last box of a short line, toward the layout's far edge. It reaches only as far as a latch of eight units, so edges that almost line up meet and a box far short of its neighbour keeps its own size (stretched all the way, a small group became a large box of empty tint beside a tall one). The content stays where the padding put it, and a box whose stretched edge would reach into the title-block corner keeps its own size.

**Group colours.** Every box is drawn dashed, in its group's colour over a faint tint of it, and the caption takes the same colour, so a subsystem reads as one block at a glance. Power groups are warm, connector and mechanical groups neutral grey, and every other group takes the next colour of a fixed cycle in sheet order, so neighbours differ and the same design is coloured the same way every time.

**Boxes never intersect.** After the sheet is drawn, any two group boxes that intersect widen the right-hand group's tiling reserve (or, across the wrap, the gap between rows or columns) by the overlap, a box past the frame or grown into the title block's corner shrinks the usable frame by its overflow, and the sheet is drafted again, at most three times; placement is a pure function of the intent and these reserves. A box still across the frame or in the title block's corner after that moves the sheet up a paper size, and again while a larger one remains (never when the intent pins the paper). A sheet that still has a box wrong after that says so in its notes. The title block is KiCad's default one, 110 mm wide and 34 mm tall at the bottom right, the same on every paper.

## Amplifiers, transistors and the placement search

These passes came from drafting analog boards: an audio preamp with op-amp buffers, a Sallen-Key filter and a push-pull output, an instrumentation amplifier, comparators with hysteresis, a 555 flasher and a long-tailed pair.

**Feedback drawn around the amplifier.** An op-amp output tied to its own inverting input is its feedback, and a reader looks for it drawn around the amplifier. That pair is routed first, before any clustering, as a loop: from the output's stub the wire drops (or rises) past everything between the two pins, crosses, and comes back into the input's stub. When the output's stub end already carries a hung part (a follower's output cap), the loop taps the stub a unit out from the pin, with a junction. Every variant that clears is kept, and the one crossing the fewest wires wins. The loop carries no name of its own when the net goes on: the output names it there. A net that is only the loop is named once. A part hung dead straight on such an output would sit where the loop has to go, so the output keeps its stub for the loop.

**Inverting stages turned over.** An amplifier whose inverting input is a summing junction (fed back from its own output and fed a signal from elsewhere: inverting, summing, integrating and differential stages) is drawn mirrored, inverting input on top, so its feedback lies over it the way every handbook draws it. A non-inverting stage or follower keeps the symbol's own orientation, non-inverting input on top: a gain leg that ends on a rail, or a bootstrap back to the non-inverting input, is not a signal. Only passive parts (at most three pins, all passive: resistors, capacitors, pots, diodes, a log amp's transistor) carry feedback; an analog switch across the loop is neither feedback nor an input, so a switched-gain non-inverting stage stays upright.

**Fan-in.** A second or third independent input into a pin that already carries a series run (a summer's inputs) lies on a row of its own, the rows stacked five apart away from the amplifier's other input, first reference on top, and joined by one bus. Hung from the pin instead, each read as a shunt to its own input terminal.

**Feedback bridges.** A two-lead part between an amplifier's input and that unit's own output (a gain or hysteresis resistor, a compensation cap) lies across the amplifier: over the top from the upper input and under the bottom from the lower one, the way a drafter draws feedback. The amplifier's cell makes room for its bridges above and below, and a bridge on the side of a supply pin passes beyond that pin's power symbol and name, so no supply arrow lands on a feedback part. Laid along the input's row instead, its output end had to be wired back under the amplifier, through whatever hung from the other input (a comparator's hysteresis resistor crossed its own divider twice).

**One series run per row.** A row carries one series run. A second one laid past the first would end at the first's far net, not the pin's, and have to be wired back around it, so it drops from the pin in a lane of its own instead.

**Transistors anchor their base.** After the ICs, connectors and switches, each transistor claims the parts on its base or gate the same way an IC claims the parts on its pins: a base pull-down hangs from the base row on the base's own side, rather than in a column past the transistor where its net crossed the collector's. A transistor already on a row or hung anchors nothing itself.

**Stacked parts keep their stubs apart.** A pin facing up draws a stub toward the part above, whose pin facing down draws one toward it. On two different nets the two stubs need a unit of air between them, and room for a flag reading along either one, or one net's label lands on the other's wire and KiCad joins them. Rows are only ever pushed down for it, a whole unit at a time.

**Routes judged against every stub.** A route is judged against the stubs of nets drafted after it as well as the wires of those before, each stub taken two units longer than drawn, the room its label needs. Among candidate shapes (trunk, comb, hook, loop) the one crossing the fewest foreign wires is taken, then the one with the fewest segments, which is the fewest bends. Parts placed in columns are wired only where the wire crosses no other net: a run drawn across another net's wire reads as a short, and labels say the same thing without one. A part hung on a pin always keeps its wire.

**The placement search.** The placement rules decide where each part goes; the search then tries the orientations a drafter would choose by eye. Each connector is tried turned over (top to bottom) and mirrored (left for right), and each two-lead part in its other three orientations, lying horizontal or end for end. Only a part with work to do is tried: one with a pin whose wire bends before it gets anywhere, or that ends in a label where a wire might reach. A connector is only ever mirrored, never turned. A crystal and the load caps on its signal pins are left to the flanking idiom. A variant is kept when the sheet improves in this order: fewer labels printing on another label, a foreign wire or a part's body (measured as the legibility checker measures text), then fewer wire crossings, then less cost, where cost is wire length plus 25.4 mm per label and 2.54 mm per bend. Charging for labels keeps the search from trading wired runs for labels; charging for bends means a turn has to buy back two units of wire. A variant must also keep the same or a smaller sheet, hold every gate, and keep its part upright: a connector keeps its rotation, and a turned part never stands with its ground end up or its supply end down. Trials are ranked on one draft pass each, and the kept orientations are then drafted in full once, which is kept only if it beats the unturned draft.

**Crossings labelled away.** A crossing the orientations could not remove is tried once more net by net: the net is drawn as labels between its column-placed parts instead of a wire, and kept when the crossings drop. A hang, a bridge or a row keeps the wire to the pin it belongs to.

**Flags on neighbouring rows.** Flags on neighbouring pin rows (never two on one row) stack edge to edge, the way a header's signals read down its pins; any other pair of texts keeps the 0.8 mm pad. A power symbol's own glyph (arrow, bar or flag) is an obstacle to every name placed near it.

The search costs one draft pass per trial, so the budget of passes shrinks with the part count: 60 up to 25 parts, 15 at 100, never under 6. A sheet of more than 25 parts that already has no label on anything and no crossing is not searched at all; a smaller sheet is still searched for less wire. The passes go first to the parts on the nets that cross, with intent order breaking ties, so the result stays deterministic on every machine; the draft report says when the search stopped early.

`COPPERHEAD_DRAFT_TRACE=1` prints every one of these decisions: what each pin claimed and why a part was skipped, each lane's position, each refused hang or run, every label that could not be placed where it stood and where it went, and every wire crossing by net.

## Conventions the sheet follows

The target the engine draws toward, collected from practitioner guides, a hand-drawn reference board and the KiStack schematic skill's checklist, re-expressed here. Where a rule is the engine's, it is enforced by construction and gated; where it is the intent's, the stage prompt asks for it.

| Convention | Whose | How |
| --- | --- | --- |
| Signals flow left to right; the IC leads its group; connectors on the left | engine | IC-first layering, connector column |
| A part sits on the pin it serves: shunts hang in lanes, one junction per pin, series parts lie on the row, test points are terminals at the end of their run (on a busy row they rise beside it; on a rail they stand in a grid at the group's right end); connectors and switches anchor their parts too | engine | pin-anchored hangs, lanes with level bases, inline runs, node hangs |
| A transistor sits at the end of the run that drives it, base to the driver, collector up; its base parts hang from the base | engine | mirrored inline runs, transistor anchors |
| Feedback drawn around the amplifier; a gain or hysteresis part bridges across it | engine | feedback loops, feedback bridges |
| A connector's pins face the parts they serve; no avoidable crossing | engine | placement search, crossing nets labelled |
| No two-pin part is left as a labelled island | engine | hangs, runs, node hangs, chain pass; gated on the reference boards |
| Wire what is local, label what is not; one label per wired run | engine | cluster-first routing |
| Rails and grounds are symbols, rails up and grounds down, one per bank of caps; a glyph that would sit on a neighbour turns along its stub instead | engine | power pass, bank trunks |
| Decoupling in banks with shared symbols; a PWR_FLAG at each undriven rail's first endpoint | engine | bank idiom, flag synthesis |
| Every part carries a reference and a value that collide with nothing, 0.8 mm of air between texts; all text horizontal, on turned parts too | engine | field slot ladder, text padding, KiCad field angle |
| Related nets coloured together: rails, grounds, and every family of signals sharing a prefix; lone signals in the theme default | engine | wire and label colour |
| Subsystems as captioned, coloured boxes that enclose their own text, labels and wires; page sized to content; boxes compact and aligned | engine | group rects, enclosure, compaction, sheet grid, latch |
| Bus and interface nets share a prefix; differential pairs end in +/- or P/N; values carry units | intent | stage prompt |
| Notes, datasheet references and design intent on the sheet | not yet | needs a notes field in the intent |

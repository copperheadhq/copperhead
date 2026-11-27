---
title: Board layout framework
description: How copperhead lays out a board without owning a placer or a router, what it supports, and how to set the engines up.
sidebar:
  order: 4
---

copperhead does not place or route boards itself. It wraps engines that do, behind one fail-closed contract, and owns everything around them: the canonical board representation, the intent you declare, the verification every candidate must pass, the ranking, the repair loop, and the evidence. The standard is [RFC 11](https://github.com/copperheadhq/copperhead-rfcs/blob/main/rfc/rfc11.md); the implementation is the `copperhead pcb` command group and the `pcb_layout` / `pcb_repair` tools.

## What happens in a layout run

1. **Import.** The `.kicad_pcb` (and its `.kicad_pro`) is read into copperhead's own IR: integer nanometres, stable ids, a content hash. Nothing is round-tripped; edits go back as anchored text replacements.
2. **Intent.** The board's own rules (net classes, locked parts, keepout areas) are always in force. An intent file in the RFC 11 §7.3 language adds fixed positions, edges, attachments, functional groups, separations, keepouts, and routing widths and priorities. `copperhead pcb infer-intent` compiles blocks and roles from your docs and, with a model, datasheet-derived rules that must cite their source.
3. **Placement.** The staged plan places what a constraint already fixes first (edge parts, fixed positions, block anchors in their signal-flow slots, attached parts beside their pins, approved reference blocks), holds those, and hands the rest to the wrapped placers. Every candidate is legalized (out of keepouts, blocks apart, in from the board edge), verified, measured, probed for routability, and ranked. The control, the placement as given, always competes.
4. **Routing.** Power and ground first at their class width with pours preserved, critical nets next, the bulk by race across the wrapped routers. Every candidate is re-imported, its zones refilled, and verified by copperhead's own checkers with KiCad DRC as one voter.
5. **Repair.** The first pass takes the whole budget it needs; the repair cycles run on what remains (B4 measured that holding half back cost clean passes and repaired nothing). While the budget lasts and the result is not clean, the planner picks one action from a fixed catalog over the findings alone (keep the copper and route only the owed nets, rip up nets, tune or switch the router, reorder nets, move a group, take the next ranked candidate). A hard constraint no action can meet ends the run in `HOLD`; nothing is ever silently relaxed.
6. **Evidence.** The run directory holds every candidate with its provenance; `docs/LAYOUT.md` gets the evidence section (engines, winner, metrics, owed connections, the per-subsystem table, the repair cycles, the bundle path and the board hash). `copperhead check` re-verifies that board from then on and fails if it changes without new evidence.

## Supported envelope

Published with the release, per RFC 11 §10.7. Anything outside it ends in `HOLD` or `REFUSE` with the reason.

- Two, four, or six copper layers with through vias only (a blind or buried via fails the routing gate), a single closed outline, fewer than 50 components. The copper stack is read from the layer names, so KiCad's older numbering (`In1.Cu` 1, `B.Cu` 31) and its current one (`B.Cu` 2, `In1.Cu` 4) are the same board.
- Low-speed digital and DC power only: no RF, no differential pairs, no length matching, no controlled impedance.
- 48 V or less. Power nets need explicit geometry or a complete, approved fabrication and thermal rule set; a current figure alone gives an advisory width, not a hard one.
- No copper pour generation: pours in the input are preserved, refilled, and verified.
- Three fabrication profiles, `jlcpcb-2layer`, `jlcpcb-4layer`, and `jlcpcb-6layer`, chosen by the board's copper count unless the configuration names one; a configured profile for another layer count is a pre-flight refusal. On four and six layers the inner layers get alternating preferred directions by default (the intent file's `routing.layers` overrides them), and scoring drops the two-layer return-path terms because the plane layers carry the return path.

## Engines and how to set them up

| Engine | Kind | License | Runs as | Needs |
| --- | --- | --- | --- | --- |
| Freerouting 2.4.1 | router | GPL-3.0 | separate process | a JRE 25 and the jar (`scripts/tools.sh jre freerouting`, or the KiCad Freerouting plugin, or `COPPERHEAD_FREEROUTING_JAR` / `COPPERHEAD_JAVA`) |
| kicad-tools 0.20.0 | router and two placers | MIT | separate process | `kct` (`scripts/tools.sh kicad-tools` or `pip install kicad-tools==0.20.0`, or `COPPERHEAD_KCT`) |
| pyplacer | placer | BSD-3-Clause | separate process | Python 3.10+ with numpy; vendored under `vendor/pyplacer` with a `--fixed` patch |
| the fixed placer | placer | Apache-2.0 | in process | nothing; it is the control |
| reference placer and router | both | Apache-2.0 | in process | nothing; harness fixtures only, never eligible for a real board |

Every engine gets a scrubbed environment (no `*_KEY`, `*_TOKEN`, `*_SECRET`, `PASSWORD`), an immutable input snapshot whose hash is checked afterwards, and a wall-clock and engine-second budget. An engine that is not installed makes the run `UNSUPPORTED` with the install hint; one that crashes makes it `ENGINE_ERROR`; one that touches its input makes it `INVALID_OUTPUT`. Copyleft engines are only ever run out of process.

What the engines are actually good for is measured, not assumed: [copperbench](https://github.com/copperheadhq/copperbench), a separate repository, runs the golden microboards and a 20-board PCBench subset through these same code paths, and its milestone reports say what each engine did. At the time of writing, Freerouting routes most small two-layer boards clean; kicad-tools' routers and placers are usable on few real boards at this version; the human placement beats every wrapped placer on real boards, and the staged plan's rule stages are what satisfy declared intent.

## Configuration

Everything lives under the `pcb` block of `.copperhead/config.json`: engine order, mode, budget, profile, the intent file path, reference designs, layout blocks. See the [configuration reference](/reference/configuration/#pcb) and the [`pcb` commands](/reference/cli/#copperhead-pcb).

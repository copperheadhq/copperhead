---
title: How placement works
description: What copperhead does when it places a board — reusing a reference, planning in the engineer's order, packing deterministically, and what the measurements actually show.
sidebar:
  order: 6
---

copperhead places a board by **adapting one that already works**. It matches the board against a reference, moves that placement into the new board's frame, and repacks only what no longer fits. Where there is nothing to reuse, it packs from the connections alone.

Two rules shape everything below:

- **A model may plan; it never gives a coordinate.** The model says which parts belong together, roughly where each group sits, which relationships are critical, and the order to build in. Every coordinate comes from a deterministic packer.
- **Nothing is accepted because an engine said so.** Every candidate is materialised into a real KiCad file, verified, and ranked, and the few that survive have their critical nets routed.

## The pipeline

```
import → feasibility → subsystems → critical relationships
      → match → transfer → delta → plan
      → phased packing → free-space search
      → variants → screening → materialise → verify → rank
      → critical routing
```

### Feasibility, before anything moves

Courtyard area over board area, per side. Measured on 23 designer boards: median 48 %, p90 62 %, maximum 93 %. Above 62 % the run warns that it is working past what designers ship on that outline; above 95 % it refuses, because no legal placement exists and an hour of packing will not find one.

### Subsystems

The sets of parts a designer places together, derived four ways — from the intent file's headings, from hierarchical sheets, from the nearest anchor IC over the part graph, and by Louvain clustering — each under three clean-up settings. Identical partitions merge. None is chosen up front: they are variants the placer tries.

Measured on 11 KiCad demo boards with sheets: sheets score highest for purity (0.78), nearest-anchor close behind (0.74), Louvain lowest (0.58).

### Critical relationships

Fourteen classes — decoupling, bootstrap, config, crystal, hot loop, output chain, aggressor, sensitive, channel, thermal, RF keepout, mechanical, signal, low — inferred from pin functions first, net names second, reference prefixes and footprints third, and **topology** where names fail. A discrete boost converter names nothing, so the switch node is found as an inductor's net that also carries a transistor or diode and is too small to be a rail.

Each class decides three things: the phase that places its parts, the weight its nets carry in packing, and the check that verifies it.

### Match, transfer, delta

Parts are matched to the reference across six tiers, strongest first: schematic symbol path, refdes and footprint, refdes alone, footprint and net signature, footprint and value, package family and value. Matching is one-to-one and greedy, so a weak tier never steals a part a strong one can claim.

The reference's placement then moves into the target's frame by **one rigid transform** — translation plus a quarter turn, never a scale, never a mirror — fitted on the board's fixed anchors when it has two or more, and otherwise by centring the reference's *outline* on the target's. (Centring the reference's *parts* instead was a bug: it shifted every part on boards whose placement is not centred.)

The delta is what changed: parts added, parts removed, footprints swapped, nets gained and lost, outline and utilisation. It is what the model reads before it plans.

## The plan

A plan is data, not coordinates: regions, subsystems with anchors, orientations, critical relationships, and the phases to build in. Written by rules, or by a model with `--model`.

A model's plan is **validated before use**. A plan that names a part not on the board, puts a part in two subsystems, or leaves a movable part out of every phase is refused and the rules' plan runs instead. The model cannot raise a constraint's severity: what it adds arrives advisory with capped confidence, and a rule or the user's intent always outranks it. Every call is recorded by the hash of its input, so a run replays offline.

## Phased packing

Phases run in the engineer's order — **mechanical, regions, anchors, support, loops, separation, remaining** — one packer solve each, per board side. Everything placed so far goes in as static; everything a later phase will place is left out entirely, so a part waiting its turn never blocks the board it has not been placed on yet.

Coordinates come from **tscircuit's `calculate-packing`**, vendored at `a2d60ae` with five patches (exact boundary containment, weighted network distance, no silent centre fallback, failure detail, per-network weights). The plan is compiled into the only things it understands: static parts, a boundary, obstacles, per-network weights (hot loop 8, decoupling 6, signal 1, power 0.25, ground 0), and a pack order. Where the plan wants a part becomes a **point attractor** — a one-pad static component on a private network — so the part is pulled there without any coordinate being imposed.

Three placements do not come from the packer, and the phase report says so:

1. **Mechanical parts follow the plan.** A connector belongs where the board's mechanics put it.
2. **A part the packer rejects falls back to its planned position**, when that position is legal.
3. **Failing that, the board is searched for free space.** This matters more than it sounds: the packer proposes positions only along the outline of what it has already placed, so past roughly half full it cannot see the interior pockets that remain. The search grids the board, orders candidates by where the part's connections want it, and takes the best legal one. Adding it took schematic-only placement from 8 of 13 boards to 12 of 13.

Legality is judged on courtyard **polygons, per side** — a box around a rotated or L-shaped courtyard reports overlaps KiCad's own check does not, and the other side of the board is another board unless a part goes through it.

## Variants, screening, ranking

A run produces several boards, not one:

- **Option A** keeps every reference position still legal
- **Option B** repacks, pulled toward the reference at varying strength
- **Option C** ignores the reference and packs from the connections alone

Each is screened **in memory** — a packer solve and a geometry check, milliseconds each — and identical placements are merged. Only the survivors are materialised into real KiCad files, verified with DRC, and ranked.

Ranking is **tiered**, in the engineer's order: what the board declares, then current loops, then isolation, then whether the critical nets route, then length, then neatness. A candidate better in an earlier tier wins whatever the later tiers say — a violated hot loop is not paid for by a shorter net.

## Critical routing

The last step before accepting a placement is routing the few nets that decide whether the board works, then throwing the copper away. The critical nets of the top five candidates are routed, and the candidates are ranked again on the result. That final ranking is the one the run stands by: the outcome it prints, `ranking.json`, and `--apply` all follow it. See [How routing works](/concepts/routing/) for the protocol and what V6 and V7 mean.

## What a run leaves you

```bash
copperhead pcb reuse --reference old/board.kicad_pcb            # options, no change to the board
copperhead pcb reuse --reference old/board.kicad_pcb --apply    # write the selected option
copperhead pcb diff HEAD:hardware/board.kicad_pcb hardware/board.kicad_pcb
```

The run directory holds:

- **`placement.md`**, the document to read. It is written once when the plan is validated, so you can stop a run whose plan is wrong, and again when the run ends. In order, it covers the board, the plan, the critical constraints, the candidates offered, the selected candidate's changes, and what remains.
- **`options.md` and `delta.md`**: what each option traded away, and what changed against the reference.
- **`variants/<option>/`**: each option's board, its render, and its placement diff against your board, as `placement-diff.json` and `placement-diff.txt`.

Every part of your board is owned by the import, so each move is marked as needing approval (`!`). Passing `--apply` is that approval. Without `--apply`, nothing is written to your board.

## What the measurements show

On 23 benchmark cases — golden microboards, generated capability boards, and real PCBench designs:

| | |
| --- | --- |
| Placed, routed, no critical DRC (V7) | **17/23** |
| Of the 6 shortfalls | 5 fail exactly as the designer's own board does; 1 declares no critical nets |
| Median wire length against the designer's | 98 % |
| Legal **from the schematic alone**, no reference | 21/23 |

The schematic-only number is the honest measure of placement ability: netlist, footprints, outline and fixed connectors, and nothing from the designer's board. It holds to about 60 % utilisation.

## What it cannot do yet

- **Dense boards.** The two failures are at 51 % and 62 % utilisation, where greedy placement paints itself into a corner. Fixing them needs relocation — moving parts already placed — which the packer's islands and local search would provide and which are not implemented.
- **Revision.** The rules exist and are tested — turn a part to face what it must reach, swap two identical parts, release whatever sits between them — but nothing yet feeds routing failures back into them.
- **The model's contribution is unproven.** It plans structurally sound boards: on a 51-part design it produced 7 subsystems, 21 critical relationships and 6 phases, and every one of its variants was legal. But across the model subset it won 1 case of 3, at 45–60 s of planning against roughly zero for the rules. The measurement now exists; the benefit does not yet.
- **Quality beyond legality.** Beating a designer on wire length on a sparse board means little. Relative part ordering is preserved 33–84 % of the time, which is a large spread and not yet understood.

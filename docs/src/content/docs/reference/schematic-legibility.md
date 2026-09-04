---
title: Schematic legibility rules
description: The drafting standard for generated schematics and the deterministic checks that enforce it.
sidebar:
  order: 3
---

:::note
Specified by the `deterministic-schematic-drafting` OpenSpec change. This page describes the contract; the checker and the gate land with that change's implementation. How generated sheets come to satisfy these rules by construction is described in [How copperhead drafts schematics](/reference/schematic-drafting/).
:::

ERC verifies the net graph, and `verify_symbols` verifies the parts, but neither says anything about how the drawing reads. The schematic is the primary human review surface for everything the agent designs, so legibility is checked the same way: a deterministic, read-only checker (`check_legibility`) that reports findings the agent must reconcile before the schematic stage of `create` can complete.

## The drafting standard

Generated sheets follow these rules. The agent is told them up front, and the checker verifies the ones with a mechanical answer.

- **Subsystem group boxes.** Every non-power symbol belongs to exactly one drawn group: a `(rectangle)` outline with a `(text)` caption inside its top band naming the subsystem. Solid stroke for functional blocks, dashed for annotation clusters (a decoupling bank, a boot/reset cluster, spare gates). Captions must name a subsystem from SUBSYSTEMS.md or a component group from BOM.md. Power ports (`power:` symbols and `PWR_FLAG`) are exempt from membership.
- **Block-partitioned layout.** Groups tile the sheet in columns without overlapping. A large MCU or connector gets its own full-height column. Signal flow runs left to right inside a group, power rails toward the top, grounds toward the bottom.
- **Labels between blocks, wires within them.** Wires stay short and local inside a group. Connections between groups use net labels, not long wires crossing the sheet.
- **Page sized to content.** The paper size is chosen so the groups fill the frame instead of crowding one corner or spilling off the edge.
- **Title block filled.** Title, revision, and date are populated.
- **Everything on grid.** Symbol origins, wire endpoints, and label positions sit on the 1.27mm grid. An off-grid pin silently fails to connect, so grid findings are always reported first.

## Check families

Each finding carries a stable kind identifier. Error-severity families gate the `create` schematic stage; advisory families inform but never block.

| Kind | Severity | Detects |
| --- | --- | --- |
| `off-grid` | error | A symbol origin, wire endpoint, or label position off the 1.27mm grid. Reported first. |
| `symbol-overlap` | error | Two symbol body boxes intersecting. |
| `text-collision` | error | Reference, Value, label, or free text over a symbol body, a wire, or other text. |
| `wire-through-symbol` | error | A wire crossing a symbol body without terminating on one of its pins. |
| `out-of-frame` | error | Content outside the usable frame area or over the title block. |
| `ungrouped-symbol` | error | A non-power symbol inside no group rectangle. |
| `unlabeled-group` | error | A group with no caption, or a caption naming nothing in SUBSYSTEMS.md or BOM.md. |
| `group-overlap` | error | Two group rectangles intersecting without one fully containing the other. |
| `empty-title-block` | error | An empty title, revision, or date field. |
| `label-orientation` | advisory | A label rotated 90 or 270 degrees where a horizontal draw would collide with nothing. |
| `low-utilization` | advisory | Content occupying less than the configured fraction of the usable frame area. |
| `crowding` | advisory | Neighbouring symbols closer than the minimum readable pitch. |
| `cross-group-wire` | advisory | A wire crossing a group boundary, or exceeding the maximum length, where a label pair belongs. |

The split is deliberate: every gating family has an unambiguous answer and a single resolving move, while the advisory families rest on thresholds, and gating on a threshold invites the repair loop to thrash against a number instead of fixing a defect.

A horizontal label is measured standing on its anchor, one text height above the wire it names and nothing below it, the way eeschema draws it; a label on a horizontal wire is therefore not text on a wire. What the checker deliberately excludes: pin name and pin number text participate in no collision test (they sit inside IC outlines by design), a label never collides with the wire it is attached to, and text extents are estimated at a fixed 0.6 × font height per character, below the stroke font's average advance, so the checker misses marginal collisions rather than inventing them.

## Where the checks bind

- **`copperhead create` gates.** The schematic stage completes only when the sheet has symbols, BOM/PINOUT are drift-clean, ERC passes, and zero error-severity legibility findings remain. Error findings also feed the sync-obligations ledger, so `finish` refuses while any are outstanding. Editing the schematic re-opens the obligation; a clean `check_legibility` run clears it. The ledger obligation binds only on repos copperhead created: a `do` run on a hand-drawn schematic gets the same findings as information, never as a block, since a pre-existing sheet should not have to be redrawn to accept a one-line edit.
- **`copperhead check` reports.** Findings print grouped by severity, and the exit code is unaffected at every severity: hand-drawn schematics in existing repos gain information, not a new failure class. `check --json` carries a `legibility` object with the findings, per-severity counts, and any skipped or disabled families. The key is always present, even when clean or when no schematic is configured.
- **Loud skips, never silent.** An unrecognized `(paper)` size skips the page-relative checks with a stated reason. A missing SUBSYSTEMS.md or BOM.md skips caption validation the same way, while the geometric group checks still run.

## Configuration

Optional `legibility` block in `.copperhead/config.json`. Absent keys use these defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `thresholds.gridPitch` | `1.27` | Grid pitch in mm for the `off-grid` family. |
| `thresholds.minPitch` | `2.54` | Minimum readable symbol pitch, edge to edge between body boxes, in mm. |
| `thresholds.utilization` | `0.5` | Minimum fraction of the usable frame area content should occupy. |
| `thresholds.maxWireLength` | `50.8` | Wire length in mm beyond which a label pair is suggested. |
| `thresholds.familyCap` | `10` | Maximum findings per family per sheet; the remainder is reported as a suppressed count. |
| `severity.<kind>` | per table above | Override any family to `error`, `advisory`, or `off`. `off` disables the family and the report says so. |

Geometric comparisons apply a 0.01mm tolerance so file-precision noise cannot flip a finding.

## Finding format

Every finding is `{kind, severity, sheet, at: {x, y}, refs, detail}`, where `detail` states the defect and the concrete fix. Pairwise families report each unordered pair once. The checker walks the full sheet hierarchy from the root schematic and attributes each finding to the sheet it came from, using that sheet's own paper size for page-relative checks.

## The score

`copperhead score schematic` (and the `score_schematic` tool, and every `draft_schematic` report) measures the judgment calls the checker does not gate on, as a weighted 0 to 100 composite with its per-metric breakdown. Two composites are reported.

**The gated composite** carries the drafting standard: it needs group boxes, captions and a filled title block, and any error-severity finding caps it at 40, so a high score never coexists with a gating defect. Its metrics, with default weights: `pin-attachment` 10, `island-parts` 5, `wire-crossings` 10, `wire-bends` 5, `wire-length` 5, `label-to-wire-ratio` 5, `group-cohesion` 10, `flow-direction` 10, `utilization` 10, `axis-alignment` 10, `spacing-uniformity` 10, `straight-wire-ratio` 5, `label-alignment` 5, `whitespace-balance` 10, `pair-symmetry` 5. Weights are configurable under `score.weights` in `.copperhead/config.json`.

**The wiring-style composite** measures only how the parts connect, is never capped, and uses none of the standard's conventions, so a hand-drawn sheet without group boxes and an engine draft of the same circuit compare on one scale. It is what the pin-attachment work is measured against.

| Metric | Definition | Weight (style) | Where a person lands |
| --- | --- | --- | --- |
| `pin-attachment` | share of two-pin parts with at least one pin wired straight to another part's pin | 30 | 0.90 to 1.00 |
| `island-parts` | share of two-pin parts whose every pin ends in a label or nothing | 20 | 0.00 to 0.02 |
| `power-symbol-economy` | power symbols per part | 15 | 0.3 to 1.2 |
| `labels-per-part` | net labels per part | 15 | under 1 outside bus-heavy boards |
| `crossings-per-wire` | proper wire crossings per wire segment | 10 | 0.03 on a 90-part board, 0.77 on an 1100-part one |
| `straight-wire-ratio` | segments not part of a bend | 10 | |

"Wired straight" follows wires from each placed pin through endpoint joins and T junctions, the two ways KiCad joins wires, and counts a path that reaches another non-power part's pin. The calibration column comes from the fifteen hand-drawn demo projects that ship with KiCad 10, scored with `npm run scoresheets`, which prints any set of sheets or project directories on one table; `copperhead score schematic --file <sheet>` scores a single sheet outside any repo.

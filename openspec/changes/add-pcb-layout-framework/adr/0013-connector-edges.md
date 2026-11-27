# ADR 0013: A connector's edge is derived, not waited for

**Status:** Accepted (2026-09-17)
**RFC:** 11 §7.1, §7.3, §8.5

## Context

`partKind` classifies a connector, switch or mounting hole as `mechanical`, and `phaseOf` puts every `mechanical` part in the first placement phase. That is an *ordering*: the part is placed before the rest and nothing more. The only code that turns "mechanical" into a position is `placeMechanical`, and it acts solely on `layout.mechanical.edge.*` and `layout.mechanical.fixed.*` registry entries — which, until now, only a hand-written intent file could produce (`placement.fixed[].edge`).

The consequence, measured on `manual-tests/placement-boards/esp32-amp` at 9597b5f: with no intent file the winning candidate left the USB-C receptacle with 2.68 mm of bare board between its courtyard and the west edge, the speaker terminal 3.46 mm from the east edge, and the UART header 14.61 mm inland behind a push-button. The board is DRC-clean, scores well (HPWL 596.3 mm, 95.5 % probe routability) and cannot be plugged into. The rules planner already has the vocabulary — `PlanFixed.edge` exists and is validated — and never emits it.

A connector sitting on a board edge is a fact about the part, not a preference, so waiting for a person to state it is the wrong default.

## Decision

`connectorEdgeConstraints` (in `intent/blocks.ts`) derives a hard `layout.mechanical.edge.<REF>` entry for every connector that has none, from the signal-flow regions `assignRegions` already computes. Regions are equal-width vertical slots across the outline, so the leftmost block's centroid is nearest the west edge, the rightmost the east, and a block in between is nearest north or south; ties go to whichever edge carries the fewest connectors so far, then to a fixed order. `place.ts` merges the result into the registry before stage 1, so every engine sees the connectors already placed and locked, not just the packer.

The constraint also carries `along_nm`, the block region's centre on the free axis. Without it `placeMechanical` moves one axis and leaves the other at whatever the bootstrap grid gave the part — an arbitrary coordinate, and the part is locked immediately afterwards, so a collision there is one no later stage can undo. On esp32-amp that put J1 on top of U1 and failed every candidate.

Three deliberate limits:

- **Connectors only.** `wantsBoardEdge` is narrower than `isConnector`, whose refdes pattern also matches `SW` so that `partKind` calls a push-button a connector. A button belongs beside the IC it interrupts; a mounting hole, test point or jumper belongs wherever the board needs it.
- **Stated intent always wins.** An existing `edge` or `fixed` key for the same refdes is never overwritten, and a part locked in KiCad is never moved. The derived entry is `approvedBy: 'rule'`, confidence 0.8.
- **Needs a region.** A connector in the `unassigned` block gets nothing, because that block never gets a region. Give it a subsystem, or state its edge.

## Consequences

On esp32-amp all three connectors land 0.75 mm from their edge — the `placeMechanical` inset (copper-to-edge clearance plus 250 µm) — and are the three parts closest to any edge. Wirelength gets worse, as it must: HPWL 596.3 → 635.7 mm (+6.6 %), with probe routability unchanged at 95.5 % and congestion overflow 4 → 2. Locking three parts early also helps the engines that were failing the gates: pyplacer's courtyard overlaps fall 9 → 4 and kicad-tools-physics's 265 → 231, though both remain ineligible.

A board whose connectors were already positioned is unaffected only if they are locked or named in the intent file; otherwise they will be moved to the edge their subsystem faces. That is the intended behaviour, and it is why the derivation is gated on `--blocks`.

`pcb infer-intent` does not report these entries: it compiles from its own path and has no block regions. The constraints appear in a `place` run's log (`intent: J1 -> west edge (derived from its block region)`) and in the run's `plan.json`.

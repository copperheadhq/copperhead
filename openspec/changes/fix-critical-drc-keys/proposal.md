## Why

Critical DRC is the gate that decides whether a board is shippable, and it has
three verified defects:

1. The fabrication profiles list `hole_near_hole`. KiCad 10 emits `hole_to_hole`,
   so the rule never matches and hole-to-hole violations are counted as ordinary.
2. The checker reads only the violation (error) bucket. KiCad reports several
   critical rules at warning severity depending on the board's own rule set, and
   those are silently dropped.
3. The routability probe reports the total error count where it means the
   critical count, so a board with many cosmetic errors and no critical ones
   looks worse than a board with one short.

Each of the three makes the gate read cleaner than the board is. That is the one
direction a verification defect must never fail in.

This change was specified as part of `add-placement-benchmark`, which has moved
to the copperbench repository. The fix belongs here, in the checker that has the
bug; the benchmark that exposed it depends on a copperhead that has it fixed.

## What Changes

- `hole_to_hole` replaces `hole_near_hole` in `jlcpcb-2layer`, `jlcpcb-4layer`
  and `jlcpcb-6layer`, and in the profile index.
- `kicad-drc.ts` counts profile-critical keys across both violations and
  warnings.
- A new `drc_placement_critical_count` metric reports the placement-stage subset
  (courtyard overlap, pads and holes inside courtyards, items not allowed,
  copper-to-edge clearance, hole-to-hole, invalid outline), so a placement can be
  judged before any track is laid.
- `routabilityProbe` reports `routability_drc_critical` beside
  `routability_drc_errors`.

## Impact

- **Changed code:** `src/pcb/verify/checkers/kicad-drc.ts`,
  `src/pcb/verify/profiles/jlcpcb-{2,4,6}layer.json`,
  `src/pcb/verify/profiles/index.ts`, `src/pcb/engines/probe.ts`.
- **Moved numbers:** `drc_critical_count` rises on boards that have critical
  violations at warning severity. The B-series reports in copperbench are
  historical and are not rerun; their DRC columns predate this fix and say so.
- **Depended on by** the placement benchmark in copperbench, which reads these
  counts as its V5 and V7 cascade stages.

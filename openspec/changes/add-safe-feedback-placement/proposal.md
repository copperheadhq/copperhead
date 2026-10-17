# add-safe-feedback-placement: Proposal

## Why

The populated PCB is deterministic but not locally refined, while unrestricted
footprint optimization can break routed copper or introduce KiCad-only DRC
findings. Copperhead needs a small, mergeable placement improvement that keeps
the existing board whenever no verified improvement exists.

## What Changes

- Add the spec-gated `optimize_placement` agent tool for populated, unrouted,
  DRC-clean boards.
- Search bounded deterministic footprint shifts and cardinal rotations using
  complete-board placement findings, physical-pad HPWL, and separately guarded
  critical-net HPWL.
- Accept only strict non-regressions and retain the input as checkpoint zero.
- Refuse routed boards, lock mechanical parts by default, and require a clean
  baseline DRC with a known unrouted count.
- Run KiCad DRC on a proposed result. When DRC names moved parts, retry from the
  immutable input with those parts locked, for at most five passes. Restore the
  exact input if no DRC-clean, connectivity-preserving improvement exists.

## Capabilities

### New Capabilities

- `safe-feedback-placement`: deterministic local placement refinement and its
  DRC-feedback, rollback, and connectivity gates.

## Impact

- New deterministic placement measurement and refinement modules under
  `src/kicad/`.
- One new mutation capability in the existing gated agent catalog.
- No new dependencies, network calls, board routing, placement-contract format,
  or external human/model feedback protocol.

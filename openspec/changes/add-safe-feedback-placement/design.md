# add-safe-feedback-placement: Design

## Context

The trusted footprint mover already changes only footprint transforms and
preserves pad/text angles. The optimizer builds on it without changing board
population, routing, or the agent's final verification obligations.

## Decisions

- **D1: Optimize only unrouted boards.** Root-level tracks, arcs, vias, or copper
  zones cause an immediate refusal. Moving footprints away from routed copper
  without moving the routes can break connectivity even when HPWL improves.
- **D2: Keep checkpoint zero immutable.** Candidate boards remain in memory.
  The on-disk input is restored byte-for-byte after load, DRC, or connectivity
  failure.
- **D3: Use deterministic first improvement.** Reference, operator, candidate,
  and tie order are explicit; termination counts candidate evaluations, not
  time; step sizes decrease at plateaus.
- **D4: Guard every accepted in-memory move.** A candidate introduces no new
  hard or soft placement finding, does not worsen total or protected-net HPWL,
  and strictly improves at least one guarded measurement.
- **D5: Close the loop with KiCad DRC.** The tool requires clean baseline DRC,
  then verifies the proposed checkpoint. If new DRC findings name moved refs,
  those refs become locks and search restarts from checkpoint zero. Five DRC
  passes are the fixed upper bound.
- **D6: Connectivity is exact at the tool boundary.** Final unrouted count must
  equal the clean baseline count. The ordinary post-mutation `run_drc`
  obligation remains open; this internal check is an additional safety gate.

## Non-Goals

- Human or model-authored feedback.
- Golden-reference coordinate copying.
- Routed-board optimization.
- Simulated annealing, autorouting, or unbounded search.

## Rollback

Remove the capability registration and the two isolated placement modules.
No stored project format or configuration migration is involved.

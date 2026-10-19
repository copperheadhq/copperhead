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
  The on-disk input is restored byte-for-byte (kept as a Buffer) after load,
  DRC, or connectivity failure. Verification must run in place, beside the
  project's rules and `${KIPRJMOD}` libraries, so while a candidate awaits it a
  synchronous exit/SIGINT/SIGTERM guard writes the input back. The guard and
  every verification boundary compare the exact candidate bytes first: a
  concurrent edit aborts optimization and is never accepted or overwritten.
- **D3: Use deterministic first improvement.** Reference, operator, candidate,
  and tie order are explicit; termination counts candidate evaluations globally
  across DRC-feedback passes, not time; step sizes decrease at plateaus. A
  deterministic pass that ends unchanged has nothing left to find, so each pass
  gets the whole remaining budget rather than a fixed slice.
- **D4: Guard every accepted in-memory move.** A candidate introduces no new
  hard or soft placement finding, does not worsen total or protected-net HPWL,
  and strictly improves at least one guarded measurement. Findings carry a
  magnitude, so a persisting finding (same id and refs) that grows is a
  regression, and one that shrinks is an improvement. Courtyard overhang and
  opposite-side through-hole overlap carry continuous magnitudes too.
- **D5: Close the loop with KiCad DRC.** The tool requires clean baseline DRC,
  then verifies the proposed checkpoint. If new DRC findings name moved refs,
  those refs become locks and search restarts from checkpoint zero. Five DRC
  passes are the fixed upper bound.
- **D6: Connectivity is exact at the tool boundary.** Final unrouted count must
  equal the clean baseline count. The ordinary post-mutation `run_drc`
  obligation remains open; this internal check is an additional safety gate.

- **D7: Respect locks the user already expressed.** KiCad's own footprint lock
  is authoritative and independent of mechanical inference; inference reuses
  the checker's edge-connector, radio-module, and antenna patterns.
- **D8: Never block the event loop for long.** The search is a generator; the
  async driver yields with `setImmediate` every ~20 ms. Only scheduling
  changes, so determinism holds.

## Non-Goals

- Human or model-authored feedback.
- Golden-reference coordinate copying.
- Routed-board optimization.
- Simulated annealing, autorouting, or unbounded search.

## Rollback

Remove the capability registration and the two isolated placement modules.
No stored project format or configuration migration is involved.

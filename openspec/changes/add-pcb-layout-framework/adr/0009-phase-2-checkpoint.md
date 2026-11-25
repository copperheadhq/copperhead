# ADR 0009: Phase 2 checkpoint — ship the routing harness first, then Phase 3

**Status:** Accepted (2026-09-06)
**RFC:** 11 §13.5 (B1), §14.2 (checkpoint after Phase 2), Appendix B

## Evidence

B0 and B1 are published under `bench/reports/` (`B0-2026-09-06.md`, `B1-2026-09-06.md`). The B1 numbers that the milestone text demands:

- Two independent routing engines behind one contract: Freerouting 2.4.1 (GPL, out of process) and kicad-tools 0.20.0 (MIT). A third, `router-reference`, is harness-only.
- Both suites runnable: 10 golden microboards and the 20-board PCBench qualification subset (the RFC target of 40 microboards is not met; the runner and suite format do not change when the remaining 30 land).
- Identical verification for every engine: every candidate is re-imported, its zones refilled, and checked by geometry, connectivity, return path, and KiCad 10 DRC before ranking. Engines' self-reports are recorded and ignored.
- Selection regret: 0 on both suites. Invalid-over-valid selections: 0 on both suites. Harness overhead per board: 2.9 s (microboards), 3.7 s (PCBench), against 9.5 and 40 mean engine seconds.
- Clean-pass rate under equal budgets: 60 % on both suites; 12 of 20 author-placed real boards route to a DRC-clean PASS with no human help. This is reported, not claimed as uplift: with one engine dominant (Freerouting wins every completed board but two), the portfolio effect is visible on `decoupling-far` and `crossover` only.

The corpus run also did what a corpus run is for. It found four harness bugs the golden boards could not: back-side footprints emitted un-flipped to Freerouting, kicad-tools reading zero nets from KiCad 10 files, and two false refusals from legacy tolerances (a 0.4 µm annular shortfall, a 2.5 µm outline gap) plus a slot measured on the wrong axis. All are fixed with tests; a PCBench board (MIT) is now a fixture.

## Decision

Option B then A, as the RFC's checkpoint allows:

1. **Ship the routing harness now** in `create` stage 5 and `check` (Phase 4's `check` integration pulled forward): after population, the board is verified, routed by the wrapped engines with an evidence bundle, and the completion contract checks `outcome.status ∈ {PASS, PARTIAL}` and the snapshot hash. The model does not route; it may move parts between attempts. Scope is plumbing and the completion contract; the engines, verification, ranking, and evidence already exist.
2. **Then Phase 3** (placement harness) in full, with the boards users route through step 1 feeding the placement corpus.

Rejected: Phase 3 immediately. Placement is the largest phase in the plan (four placer wrappers, block derivation, the staged placement plan, reference-layout retrieval, placement gates, 30 cases, B2) and would hold back working, verified routing for weeks for no evidence gain; users cannot exercise Phase 2 until it is wired into a command they run.

Rejected: shipping routing without the checkpoint. The RFC makes this stop real so the B1 numbers are on record before any product surface depends on them; they are.

## Consequences

- `tasks.md` gains a small "Phase 2b: routing in create/check" group before Phase 3: completion contract, stage 5 wiring, `check` layout track when evidence markers are present, docs. The Phase 4 `check` task shrinks accordingly.
- kicad-tools stays in the roster but is not the default second engine for real boards until its runtime on boards over ~20 nets is understood (it ran to the 300 s budget on eight of twenty); the default `pcb.routers` order remains Freerouting first. Revisit at B2.
- Freerouting's neck-down widening and the 45° snap setting are strategy knobs to expose in Phase 3's intent work, not geometry the harness edits.
- Seed variance for Freerouting is not measurable from the CLI (no seed argument); the report says so rather than reporting a number.

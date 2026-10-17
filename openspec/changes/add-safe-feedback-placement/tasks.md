# add-safe-feedback-placement: Tasks

- [x] Implement deterministic placement measurements and bounded refinement.
- [x] Refuse routed boards and preserve an immutable input checkpoint.
- [x] Add clean baseline/final DRC and exact unrouted-count gates.
- [x] Retry from checkpoint zero with moved refs implicated by DRC locked.
- [x] Add focused determinism, refusal, rollback, and DRC-feedback tests.
- [x] Run typecheck and the focused offline tests.
- [x] Run the full offline suite and compare its failures with the known baseline.
- [x] Demonstrate a DRC-clean improvement on a Copperhead-generated board.
- [x] Prove ten end-to-end runs produce identical board bytes and tool reports.
- [x] Run build and strict OpenSpec validation.

## Review follow-ups (PR #393)

- [x] Collide courtyard-less parts by pad envelope and same-net cross-part copper.
- [x] Reject candidates that grow a persisting finding (finding magnitudes).
- [x] Honor KiCad footprint locks; infer edge connectors and radio modules as mechanical.
- [x] Give each DRC-feedback pass the whole remaining budget.
- [x] Yield to the event loop during search; memoize checker bounding boxes; cap the budget at 50,000.
- [x] Read text with no angle as absolute 0°.
- [x] Restore exact input bytes and write them back on exit during verification.
- [x] Refuse unknown critical nets and locked refs; lock duplicate refs.
- [x] Report only fully searched plateau steps; keep round-rect pad outlines inside the true pad.

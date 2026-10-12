# Mutation probe exception repair

A post-write loadability probe throwing in edit_file or move_footprint could
leave a real mutation absent from touched-file bookkeeping and reuse a stale
verification result. This follow-up registers the file and invalidates its
corresponding check before restoration, preserves existing obligations, and
reports an explicit failure. Even restored bytes require fresh verification.
If restoration fails, both errors are reported and the retained change remains
tracked. Normal rejection and already-unloadable incremental repair behavior
remain covered. This is not a claim about every tool or arbitrary I/O failure.

## Executed validation

The source base was 2f0103cd855f7fd93266b8f543361e68777fc553. Verification used
Node 24.21.0 and the prepared KiCad 9.0.9 environment. Failures were injected
at probe/restoration boundaries while exercising the actual editor, mover,
dispatcher, ledger and finish gate. This does not establish live provider parity.

- Before repair: 14 new regression cases, 7 failed and 7 passed, exit 1.
- After repair: 20 new regression cases passed.
- Combined targeted run: mutation-probe-failure (20), create-hardening (8),
  gating-sync (16): 44 passed, 0 failed, exit 0, one worker.
- Typecheck: tsc --noEmit passed, exit 0.

The new cases cover schematic/board edits and footprint moves, probe throws,
restoration failures, stale check invalidation, preserved prior obligations,
normal rejection, incremental repair and completion rejection.

No new full suite, build, recorded replay, live model experiment or original
board DRC repair was run for this increment. Earlier compatibility/full-suite
results remain evidence for their earlier candidate and are not a fresh full
suite result for this fix. The original raw DRC and historical evidence remain
unchanged. Local raw regression logs and JSON results were retained separately;
they are not uploaded as new original live-run evidence.

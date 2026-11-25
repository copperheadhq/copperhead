# Tasks: add-pcb-placement

Implements copperhead RFC 15 on the records of RFC 11 version 1.4.

## 1. Port

- [x] 1.1 Bring the framework's placement code, vendored engines,
      schemas, fixtures, tests and OpenSpec changes onto `main`.
- [x] 1.2 Apply its additions to shared code. Keep `main`'s DRC report
      shape: the harness checker splits warnings and footprint-internal
      findings itself.
- [x] 1.3 Port the `pcb` commands into `main`'s `pcb` group, and the
      layout track of `copperhead check`.
- [x] 1.4 Bring the ported tests onto `main`'s shapes, fix the tier
      test that predated `critical_completion`, and drop the committed
      Python bytecode.

## 2. RFC 11 records

- [x] 2.1 Each option's placement diff against the board as imported,
      as JSON and text.
- [x] 2.2 `placement.md`, at plan time and at the end, from records
      only; `test/pcb-placement-md.test.ts`.

## 3. Ranking

- [x] 3.1 The final ranking decides the outcome, `ranking.json`,
      `outcome.json`, and `--apply`.
- [x] 3.2 Critical routing defaults to the top five.
- [x] 3.3 RFC 15's tiers, with per-metric direction and tolerance, and the
      tier metrics derived from intent findings
      (`test/pcb-scoring-tiers.test.ts`).
- [x] 3.4 Each option as an RFC 11 candidate, so the diff marks approvals.

## 4. End to end

- [x] 4.1 `pcb reuse` on `esp32-amp` against its placed generation, with
      `--apply`, then `pcb diff` of the applied board against its git
      revision. Every candidate and diff the run wrote validates against
      the RFC 11 schemas.
- [x] 4.2 `pcb diff` reads paths and revisions in the `--repo` it is
      given, not the shell's directory.

## 5. Review

- [x] 5.1 `--apply` writes only an option eligible in the final ranking,
      and only over the board the run started from; otherwise the run
      holds and the board is unchanged.
- [x] 5.2 A reuse run loads the declared layout intent, as `pcb place`
      does, and ranks by RFC 15's tiers whether or not critical routing
      runs.
- [x] 5.3 The published package ships `vendor/pyplacer` and `vendor/ipc`.
- [x] 5.4 `pcb layout --no-route --apply` applies a placement that passed.

## 6. Next

- [ ] 6.1 The create pipeline's stage 5 runs the harness, and its
      layout-draft stage asks for evidence; un-skip the two contract
      tests.
- [ ] 6.2 Write the plan as RFC 15's plan record.
- [ ] 6.3 Block layouts and layout operations from a reuse run, and
      `--apply` through layout operations.
- [ ] 6.4 Re-cite the ported changes against RFC 15: they cite its draft
      as "RFC 14".

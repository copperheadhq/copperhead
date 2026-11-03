# gate-do-on-new-violations: Proposal

## Why

`copperhead do` can never finish on a design copperhead did not create. Its finish gate requires ERC after a schematic edit, and DRC after a board edit, to report zero violations, and real designs arrive with violations already in them: library warnings, silkscreen findings, the odd ERC error the designer accepted. On 2026-11-02 a correct five-line net rename on LibreSolar's BMS C1 (368 ERC findings including 3 errors, 168 DRC findings, all there before the run) ended `stalled` and was rolled back: the model saw that `finish` would be refused for findings the request had ruled out of scope, and stopped. Every imported or hand-maintained board hits the same wall, so the edit loop works only on boards copperhead drafted itself.

## What Changes

- On a repo that is not create-produced (its config has no `origin: create`), a `do`, `sync` or `repl` run records ERC on the schematic and DRC on the board **as it found them**, before the first edit. That is the run's baseline.
- In such a run, `run_erc` and `run_drc` pass when the report holds **no violation that is absent from the baseline**. Violations are matched one to one by severity, type, sheet and item descriptions, so fixing one finding while causing another still fails, a raised severity counts as new, and a second copy of a finding counts as new.
- Findings matched to the baseline are reported beside the result as `preexisting` (count and list), never as a failure, the way library-intrinsic findings and the AC-15.39 unrouted baseline already work. The repair budget, `finish` and the commit gate read the new findings only.
- Create-produced repos keep the zero gate: copperhead drafted those designs and answers for every finding in them.
- A baseline that cannot be computed (KiCad cannot load the starting schematic or board) leaves that check on the zero gate.
- The run summary and the commit message say how many pre-existing findings were left as found.
- `check`/`verify` are unchanged: they report the design's state, not a run's effect.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-core`: the verify step's pass condition on a design copperhead did not create, and what the run reports about findings it left as found.

## Impact

- **Code**: `src/kicad/report.ts` (`preexisting` on `CheckReport`, the matcher, `formatViolations`), `src/agent/context.ts` (the run's baseline), `src/agent/loop.ts` (recording the baseline at run start; summary and commit wording), `src/capabilities/handlers.ts` (`run_erc` and `run_drc` apply the baseline).
- **Tests**: `test/check-baseline.test.ts`: the matching, a baseline recorded with kicad-cli, and two scripted runs (an imported design finishes; a create-produced one keeps the zero gate).
- **Cost**: one ERC and one DRC at the start of a `do` run on a non-create repo (seconds on a large board).
- **Invariants**: still verification-gated out; the rule becomes "no new violations" on designs the run did not author, and stays "no violations" on designs it did. Rollback, the dirty-tree refusal and `check`'s contract are unchanged.
- **SPEC.md**: the principle line in §1, loop step 5 in §4, and AC-3.22.
- **Not in scope**: suppressing findings in `check`, a persisted baseline across runs, and accepting individual findings (the viewer's verdicts already cover that).

# gate-do-on-new-violations: Design

## Context

The verify step clears the `erc` and `drc` obligations only when `run_erc`/`run_drc` return `ok`, and `normalizeReport` sets `ok` to "no violations". Two exceptions already exist for findings a run is not answerable for: library-intrinsic DRC findings (inside one stock footprint) are reported beside the result, and unrouted connections fail only when a run raises the count it started with (AC-15.39, `unroutedGuard`). Legibility is gated only on create-produced repos (design C6: check reports, create gates). Nothing does the same for ERC and DRC findings a hand-made design already carries, so `do` on an imported board cannot pass the gate without fixing everything else first, which the request usually rules out.

## Goals / Non-Goals

**Goals:**
- A correct edit on a design with existing findings finishes and commits.
- An edit that makes the design worse in any way the checks see still fails.
- Create-produced repos keep the zero gate.

**Non-Goals:**
- Changing `check`/`verify`.
- Persisting a baseline across runs, or per-finding acceptance.
- Excusing findings by count alone.

## Decisions

### D1. The baseline is the run's own starting state, computed eagerly
At run start, after the git preflight and snapshot and before the first model turn, the loop runs ERC on the configured schematic and DRC on the configured board, on a non-create repo only. Eager rather than lazy (as `unroutedGuard` is): ERC reads every sheet of a hierarchy, so recomputing it on the starting text after an edit would need a copy of the whole sheet tree. The cost is one ERC and one DRC per run, seconds on a large board, and nothing on create-produced repos. A failed or throwing check leaves that baseline `null`.

### D2. Match one to one on a key that ignores position
A violation's key is severity, type, sheet and its item descriptions in order. Positions are left out, so a finding whose items moved but did not change is still the same finding. The matcher is a multiset: each baseline finding excuses at most one finding of the new report, so a second copy of a finding is new. Severity is in the key, so a warning that became an error is new. The violation's own description is in the key: for clearance findings it carries the measured value, so a clearance that got tighter is new. This is conservative: an edit that renames a net named in an untouched finding's item text makes that finding read as new. A false failure costs a repair turn; a false pass would let a run break the design.

### D3. Excused findings move to `preexisting`
`applyBaseline(report, baseline)` returns the report with `violations` holding only unmatched findings, `preexisting` holding the matched ones, and `ok` recomputed from `violations`. Everything downstream (the ledger, `countRepairCycle`, `finish`, the summary) already reads `ok` and `violations`, so the repair budget counts new findings only and nothing else changes shape. `formatViolations` prints the pre-existing count on the result line, the way it prints unrouted and intrinsic counts, so the model knows they are out of scope.

### D4. Order with the unrouted guard
`run_drc` applies `unroutedGuard` first and the baseline second. The guard's `unrouted_increase` finding is never in a baseline, so it stays a failure.

### D5. Create-produced repos and missing baselines use the zero gate
`isCreateProducedRepo(config)` decides, as it does for legibility. copperhead drafted those designs, and stage completion depends on clean checks. A `null` baseline means "no excuse" for that check.

### D6. Say it in the record
The run summary's ERC/DRC lines read `clean (N pre-existing left as found)` when findings were excused, and the commit message's verification line says the same, so a reviewer sees that the design was not clean, only no worse.

## Risks / Trade-offs

- **A model may lean on the excuse.** It cannot: an excused finding must have existed before the first edit, and any finding the run adds fails.
- **False failures on renames.** A net rename that appears in an unrelated finding's item text makes that finding read as new (D2). The repair turn sees both reports and can say so. Normalizing net names out of the key would hide shorts, so the conservative key stays.
- **Start-up cost.** One extra ERC and DRC per `do` on a non-create repo. Acceptable beside a model run measured in minutes.

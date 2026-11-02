# agent-core — Delta Spec

## ADDED Requirements

### Requirement: A design copperhead did not create is held to no new violations
On a repo whose config does not mark it create-produced, a `do`, `sync` or `repl` run SHALL record ERC on the schematic and DRC on the board as it found them, before its first edit, and `run_erc` and `run_drc` SHALL pass when their report holds no violation absent from that baseline. Violations SHALL be matched one to one by severity, type, sheet and item descriptions. Matched findings SHALL be reported beside the result as pre-existing and SHALL NOT fail the check, cost a repair cycle, or block `finish` or the commit. A create-produced repo SHALL keep the zero-violation gate, and a check whose baseline could not be computed SHALL fall back to it. `check` and `verify` SHALL report every violation as before.

#### Scenario: Edit on an imported design finishes (AC-3.22)
- **WHEN** `do` makes a correct edit on a non-create repo whose ERC and DRC already report violations, and the edit adds none
- **THEN** `run_erc` and `run_drc` pass, report the matched findings as pre-existing, and the run commits

#### Scenario: A new violation still fails
- **WHEN** an edit on a non-create repo fixes one pre-existing finding and causes a different one
- **THEN** the check fails on the new finding and the repair loop and rollback rules apply to it

#### Scenario: A raised severity counts as new
- **WHEN** a finding that was a warning in the baseline is an error after the edit
- **THEN** it is not matched to the baseline and the check fails

#### Scenario: Create-produced repos keep the zero gate
- **WHEN** a run on a repo whose config has `origin: create` leaves any ERC or DRC violation
- **THEN** the check fails, whatever the design held when the run started

#### Scenario: No baseline, no excuse
- **WHEN** KiCad cannot load the schematic or board as the run found it
- **THEN** that check uses the zero gate for the rest of the run

#### Scenario: check is unchanged
- **WHEN** `check` runs on a design with violations
- **THEN** it reports every violation and exits as before, with no pre-existing excuse

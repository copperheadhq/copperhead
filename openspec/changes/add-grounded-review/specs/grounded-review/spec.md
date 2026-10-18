# grounded-review: Delta Spec

## ADDED Requirements

### Requirement: Fixed deterministic sweep first
A review SHALL run the copperhead-tools `review` composite over the design and every fabrication output given, before any model pass, unless `--sweep` names an existing review record. The model SHALL NOT choose which deterministic checks the sweep runs.

#### Scenario: Fabrication outputs are swept
- **WHEN** `--fab` names a Gerber directory, a BOM and a placement file
- **THEN** the sweep's input holds the design and all three, and they are also retained sources of the bundle

### Requirement: Read-only model passes
Each domain pass SHALL offer the model only read-only queries over the bundle, `propose` and `submit`. Every call, its arguments and its result SHALL be recorded in the pass's sample, and the sample SHALL be written whole after every turn, whether the turn made a tool call, made none, or timed out. A pass SHALL end on `submit`, on its turn budget, on its time budget (a turn, query or pre-check in flight when it runs out is stopped), after three turns with no tool call, after two consecutive turns with no response or progress for the turn timeout (one such turn is retried), on a turn still producing output at the hard cap, on cancellation, on a sample it cannot save, or on a provider failure, and SHALL record which, in the sample the ending turn saves. A `propose` batch holding an invalid proposal SHALL hold none of the batch. When a pass stops, its turn's request SHALL be aborted (an HTTP provider cancels it, a subprocess provider is closed), and a query or pre-check cut short by the stop SHALL be recorded in the call log with what happened and SHALL end the pass cancelled or out of time, never with a later `submit` or an exhausted turn budget. A provider that resumes one session across turns SHALL start a new session after it is torn down, so a retried turn cannot repeat messages the stopped turn had sent. A rate-limited turn SHALL be retried with backoff. A sample written mid-pass SHALL record the outcome `running`.

#### Scenario: Proposals are pre-checked
- **WHEN** a pass proposes a fact and a citation
- **THEN** it receives each one's outcome, verifier and reason from `review-verify` in the same turn

#### Scenario: A killed pass leaves its work
- **WHEN** the process running a pass is killed after its tenth turn
- **THEN** the pass's sample on disk holds every proposal made up to that turn

#### Scenario: A turn that keeps streaming
- **WHEN** a provider turn runs past the turn timeout while it keeps reporting progress
- **THEN** it is not aborted

### Requirement: Report from verification only
The review's report SHALL be the one `review-verify` renders from every pass's proposals; the model's own text SHALL NOT appear in it except as the labelled, unverified suggested fix of a verified finding.

#### Scenario: A pass's prose is not presented
- **WHEN** a pass submits with a summary claiming findings it never proposed
- **THEN** the report holds none of them

### Requirement: Lockfile and replay
The record SHALL hold a lockfile with the model id, the template hashes, the domains, the budgets, the fabrication inputs, and the sha256 of the bundle, the merged proposals and the report. A path the lockfile records SHALL be relative to the working directory when it lies inside it, and absolute otherwise. Samples, the merged proposals and the pass summaries in `model/passes.json` SHALL be redacted at write time. Every copperhead-tools call of a review SHALL run in the review's working directory, against which a version 2 bundle's relative paths resolve, and replay SHALL run its verification in its own working directory, so a record copied anywhere replays from the directory its review ran in. Replay SHALL refuse a record that lies inside an input it names, since it writes `replay/` beneath the record. Replay SHALL refuse a record whose bundle or proposals no longer match the lockfile, and SHALL succeed only when the re-rendered report is byte-identical.

#### Scenario: Tampered proposals
- **WHEN** `model/proposals.json` is edited after the run and replay is requested
- **THEN** replay fails, naming the proposals file

#### Scenario: Committed record
- **WHEN** a review runs from a repository root over `./board` with `--fab ./fab/gerbers`
- **THEN** the lockfile records `board` and `fab/gerbers`, and no absolute path for either

#### Scenario: Record written outside the repository and copied in
- **WHEN** a review runs from a repository's root with `--sweep` and `--out` outside it, the record (without its samples) is copied into the repository, and `--replay` is run on the copy from the root
- **THEN** the replay is identical

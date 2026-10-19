# safe-feedback-placement — Delta Spec

## ADDED Requirements

### Requirement: Deterministic measured refinement

The `optimize_placement` tool SHALL start from the complete populated board,
enumerate bounded footprint translations and optional cardinal rotations, and
continue from every accepted checkpoint. It SHALL use stable ordering, explicit
rounding, and a candidate-evaluation budget rather than RNG, concurrency, or a
wall-clock deadline. That budget SHALL be at most 50,000, SHALL apply globally
across all DRC-feedback passes, and SHALL NOT reset when a moved reference
becomes locked. Each pass MAY spend everything earlier passes left.

#### Scenario: Unused budget carries to the retry

- **WHEN** the first pass converges before spending the budget and DRC feedback
  forces a retry
- **THEN** the retry may spend all evaluations the first pass left, and the
  report counts both passes against the one budget

#### Scenario: Identical input is reproducible

- **WHEN** the tool runs ten times on identical board bytes and options
- **THEN** the board bytes and tool report are identical across all ten runs

### Requirement: Strict in-memory non-regression

An accepted move SHALL introduce no new universal hard or soft placement
finding, SHALL NOT let a persisting finding's magnitude grow (edge distance,
overlap depth or area, courtyard overhang depth, pads outside the outline),
SHALL NOT lengthen any decoupling or crystal distance, SHALL NOT worsen total
or declared-critical physical-pad HPWL, and SHALL strictly improve at least one
guarded measurement.
A part without a courtyard SHALL collide by its pad envelope, and copper of two
different footprints touching SHALL be a collision even on the same net. When
no move passes, the returned board SHALL be byte-identical to the input.

#### Scenario: Flagged edge connector would drift inward

- **WHEN** an edge connector is already flagged 2.5 mm from the board edge and
  moving it inward would shorten HPWL
- **THEN** the move is rejected and the connector ends no further from the edge

#### Scenario: Courtyard-less parts would stack

- **WHEN** two parts without courtyards share a net and stacking their pads
  would shorten HPWL
- **THEN** the stacking move is rejected and their pad envelopes do not overlap

#### Scenario: Existing courtyard overhang would grow

- **WHEN** a part's courtyard already overhangs the outline and moving it
  farther out would shorten HPWL while its pads remain on the board
- **THEN** the move is rejected and the overhang depth does not grow

#### Scenario: No safe move exists

- **WHEN** every candidate regresses a guarded placement measurement
- **THEN** the tool reports unchanged and writes no board bytes

### Requirement: Default and explicit locks

Footprints locked in KiCad SHALL never move. Connectors, edge-mount parts,
radio modules and antenna-keepout carriers, mounting holes, and fiducials SHALL
be locked by default. Refs carried by more than one footprint SHALL be locked
and reported. A caller's lock or protected net that names nothing on the board
SHALL be refused before search.

#### Scenario: Footprint locked in pcbnew

- **WHEN** a footprint carries `locked` or `(locked yes)` and moving it would
  shorten HPWL, with mechanical locking turned off
- **THEN** the footprint stays at its input position and is listed as locked

#### Scenario: Custom-library edge connector

- **WHEN** a USB receptacle from a custom library has a ref that is not `J`
- **THEN** it is locked by default

#### Scenario: Protected net misspelled

- **WHEN** a caller protects `N1` and the board net is `/N1`
- **THEN** optimization is refused, naming `/N1` as the likely intent

### Requirement: Routed boards are refused

The tool SHALL refuse a board containing root-level tracks, arcs, vias, or
copper zones before evaluating any move.

#### Scenario: Existing track blocks refinement

- **WHEN** the input board contains a routed segment
- **THEN** optimization is refused and the board remains byte-identical

### Requirement: KiCad and connectivity gate every write

The tool SHALL require a clean baseline KiCad DRC and a reported unrouted count.
A proposed final checkpoint SHALL load in KiCad, pass DRC, and preserve that
unrouted count before it may remain on disk. Failure SHALL restore the exact
input bytes and SHALL NOT mark the board touched. SIGINT, SIGTERM, or ordinary
process exit while an exact candidate awaits verification SHALL write the exact
input bytes back before the process ends. The tool SHALL compare the on-disk
candidate after every load/DRC probe and immediately before rollback; when a
concurrent writer changed it, the tool SHALL abort without accepting or
overwriting those external bytes.

#### Scenario: Process exits during verification

- **WHEN** the process exits while the candidate is on disk awaiting DRC
- **THEN** the original board bytes are on disk when it ends

#### Scenario: Board changes during final DRC

- **WHEN** another writer changes the candidate bytes while final DRC runs
- **THEN** optimization aborts, does not accept the DRC result for different
  bytes, and leaves the external bytes untouched

#### Scenario: Candidate introduces a DRC finding

- **WHEN** a candidate fails final KiCad DRC and no bounded feedback retry finds
  a clean improvement
- **THEN** the candidate is rejected and the original board bytes are restored

#### Scenario: Candidate changes connectivity

- **WHEN** final DRC is otherwise clean but its unrouted count differs from the
  baseline count
- **THEN** the candidate is rejected and the original board bytes are restored

### Requirement: Bounded exact DRC feedback

When final DRC names a footprint moved by the candidate, the tool SHALL restore
checkpoint zero, lock each implicated moved ref, and repeat deterministic search.
It SHALL run no more than five candidate DRC passes after the baseline run.

#### Scenario: Silkscreen collision is repaired by feedback

- **WHEN** a candidate creates a silkscreen overlap naming a moved component
- **THEN** the next pass locks that component and may retain a different
  DRC-clean strict improvement

### Requirement: Search stays responsive

The search SHALL give the event loop a turn at least every few tens of
milliseconds while it runs, and yielding SHALL NOT change its result.

#### Scenario: Long optimization with a timer pending

- **WHEN** an optimization runs for longer than one yield slice
- **THEN** timers fire during it and the result equals the uninterrupted search

### Requirement: Existing safety gates remain authoritative

The tool SHALL be absent until a valid OpenSpec proposal unlocks mutation tools.
A successful write SHALL still open the ordinary agent DRC obligation and SHALL
NOT substitute its internal safety check for `run_drc` before finish.

#### Scenario: Proposal is not validated

- **WHEN** the provider tool catalog is built before proposal validation
- **THEN** `optimize_placement` is absent from the available mutation tools

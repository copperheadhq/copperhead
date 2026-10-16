# safe-feedback-placement — Delta Spec

## ADDED Requirements

### Requirement: Deterministic measured refinement

The `optimize_placement` tool SHALL start from the complete populated board,
enumerate bounded footprint translations and optional cardinal rotations, and
continue from every accepted checkpoint. It SHALL use stable ordering, explicit
rounding, and a candidate-evaluation budget rather than RNG, concurrency, or a
wall-clock deadline. That budget SHALL apply globally across all DRC-feedback
passes and SHALL NOT reset when a moved reference becomes locked.

#### Scenario: Identical input is reproducible

- **WHEN** the tool runs ten times on identical board bytes and options
- **THEN** the board bytes and tool report are identical across all ten runs

### Requirement: Strict in-memory non-regression

An accepted move SHALL introduce no new universal hard or soft placement
finding, SHALL NOT worsen total or declared-critical physical-pad HPWL, and
SHALL strictly improve at least one guarded measurement. When no move passes,
the returned board SHALL be byte-identical to the input.

#### Scenario: No safe move exists

- **WHEN** every candidate regresses a guarded placement measurement
- **THEN** the tool reports unchanged and writes no board bytes

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
input bytes and SHALL NOT mark the board touched.

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
It SHALL run no more than five final DRC passes.

#### Scenario: Silkscreen collision is repaired by feedback

- **WHEN** a candidate creates a silkscreen overlap naming a moved component
- **THEN** the next pass locks that component and may retain a different
  DRC-clean strict improvement

### Requirement: Existing safety gates remain authoritative

The tool SHALL be absent until a valid OpenSpec proposal unlocks mutation tools.
A successful write SHALL still open the ordinary agent DRC obligation and SHALL
NOT substitute its internal safety check for `run_drc` before finish.

#### Scenario: Proposal is not validated

- **WHEN** the provider tool catalog is built before proposal validation
- **THEN** `optimize_placement` is absent from the available mutation tools

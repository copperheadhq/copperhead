# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Routing stage

`create` SHALL run a `routing` stage after `layout-draft` and before `outputs`, in which the agent routes every remaining connection on the board layout-draft left, using `add_track`, `add_via` and anchored `edit_file` edits, and brings power copper to the SPEC.md budgets. The stage SHALL complete only when the board's (refdes, footprint id) pairs and pad nets still equal the schematic netlist's, the board passes DRC, DRC reports zero unrouted connections, and LAYOUT.md has its `## Draft quality` section. The stage prompt SHALL carry the default widths, require the widths used per net class in `## Draft quality`, and say that a re-route removes and re-adds within one batch before `run_drc`. The contract-gap message SHALL name the unrouted count and the first unrouted connections. `finish` SHALL check the stage contract before approving, as for layout-draft.

#### Scenario: Fully routed board completes

- **WHEN** the board matches the schematic, DRC is clean, DRC reports 0 unrouted connections, and LAYOUT.md has its Draft quality section
- **THEN** the routing stage is complete and `outputs` runs next

#### Scenario: Ratsnest does not complete

- **WHEN** DRC is clean but reports 3 unrouted connections
- **THEN** the stage is not complete, and the gap message names the count and the connections

#### Scenario: A broken connection still fails the run

- **WHEN** an edit raises the unrouted count above the stage's starting board
- **THEN** `run_drc` fails with `unrouted_increase`, as in layout-draft

### Requirement: Routing stage board keeping

The routing stage SHALL keep the pre-stage board (layout-draft's committed board), count it as touched so finishing requires a passing `run_drc`, start each retry from the last verified board (the board an attempt committed when it still matches the schematic, else the pre-stage board), and on any exit that does not complete the stage leave the last verified board in place.

#### Scenario: A failed routing stage leaves layout-draft's board

- **WHEN** every routing attempt fails and the diagnosis stops the stage
- **THEN** the board is byte-identical to the board layout-draft committed

#### Scenario: A retry keeps a committed routing attempt

- **WHEN** an attempt committed a partly routed board that still matches the schematic and the diagnosis says retry
- **THEN** the next attempt runs on that board

### Requirement: Routing stage resume

A repository whose board already matches the schematic, passes DRC and has zero unrouted connections SHALL count the routing stage complete without a model turn.

#### Scenario: Resume on a routed board

- **WHEN** `create` resumes on a project whose board is fully routed and DRC-clean
- **THEN** the routing stage is skipped and `outputs` runs

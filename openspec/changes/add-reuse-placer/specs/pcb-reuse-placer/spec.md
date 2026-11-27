## ADDED Requirements

### Requirement: Reuse inputs and delta table

The reuse placer SHALL take an optional reference board.

**Matching.** With a reference, target parts SHALL be matched one-to-one to reference parts in tiers, each tier removing its pairs before the next:
1. equal schematic symbol path (confidence 1.0);
2. equal reference designator and prefix class (confidence 0.95), recording whether the footprint changed;
3. equal prefix class, pad count and multiset of connected net names, where auto-generated names are compared by the part and pad they name (confidence at most 0.9; ties are ambiguous).

In `related` mode tier 2 SHALL be skipped.

**Transfer.** The reference placement SHALL be mapped into the target frame using only the target outline and fixed parts that match reference parts: a least-squares fit over two or more matched fixed parts, otherwise the outline bounding-box mapping with the rotation of highest outline IoU. The outline IoU SHALL be recorded, and a value below 0.8 SHALL be reported as `reuse.transfer.outline-mismatch`.

**Delta table.** Each target part SHALL take exactly one status: `locked`, `copied`, `footprint-changed`, `displaced`, `added` or `ambiguous`. The delta set is every part released by default. Without a reference, every movable part SHALL be `added`.

#### Scenario: A revision pair matches by reference designator
- **WHEN** `pcb reuse` runs with target `ecc83-pp_v2` and reference `ecc83-pp`
- **THEN** all 15 parts match at tier 1 or 2, the seven with swapped footprints carry `footprint-changed`, and the delta table is written to the run directory

#### Scenario: Related mode does not trust reference designators
- **WHEN** the target and reference share reference designators on unrelated parts and `--mode related` is given
- **THEN** no match is made at tier 2, and those parts are matched by signature or left `added`

#### Scenario: Nothing to adapt
- **WHEN** the delta set is empty and the transferred copy passes the placement gates
- **THEN** `placer-reuse-pack` returns the copy without packing

### Requirement: Subsystem partitions

Each applicable source SHALL produce a partition, and each partition is a variant:
- `intent`, from SUBSYSTEMS.md or the schematic intent groups, when present;
- `sheet`, one subsystem per sheet name, when the board has two or more sheets of three or more parts, with sheets kept whole;
- `anchor`, each part joining its nearest anchor IC over the part graph;
- `louvain`, modularity clustering of the same graph.

In the part graph, a net of k parts gives weight 1/(k−1), ground and rails are dropped, and power nets weigh 0.25.

Partitions other than `intent` SHALL also be produced under the clean-up settings `none`, `support` and `all`. Identical partitions SHALL be merged, keeping every source that produced them. Each subsystem SHALL be recorded as a `layout.functional.group.<slug>` constraint with its members, anchor and source.

#### Scenario: A hierarchical board keeps its sheets
- **WHEN** a board with two sheets of 29 parts and a root sheet of 10 is partitioned
- **THEN** the `sheet` partition has one subsystem per sheet, and the `anchor` and `louvain` partitions are also generated

#### Scenario: Identical partitions are merged
- **WHEN** the `sheet` and `anchor` partitions of a board contain the same subsystems
- **THEN** one variant is produced, and its source lists both

### Requirement: Placement plan and validation

A placement plan SHALL carry:
- subsystems with their role, anchor, packing mode (`island` or `flat`) and region hint;
- signal flow between subsystems;
- critical relationships;
- ordered phases: `mechanical`, `regions`, `anchors`, `support`, `loops`, `separation`, `remaining`;
- orientation hints;
- releases and keeps relative to the delta set, and resolutions of ambiguous matches;
- rigid groups;
- a reference pull between 0 and 1;
- a rationale.

Every plan SHALL be validated before execution, and invalid entries SHALL be dropped with `reuse.plan.invalid-entry`. Validation SHALL check that:
- every reference designator exists;
- each movable part is in exactly one subsystem and one phase;
- locked parts are in no phase;
- `mechanical` is first and `remaining` is last;
- no part is in a phase earlier than its critical classes allow;
- group members share a subsystem and a phase;
- model relationships have confidence at most 0.7 and are never hard;
- model partition changes carry a justification.

#### Scenario: A low-importance part cannot go first
- **WHEN** a plan assigns a pull-up resistor of class `low` to the `anchors` phase
- **THEN** that entry is dropped with `reuse.plan.invalid-entry`, and the resistor is placed in `remaining`

#### Scenario: A model cannot harden a relationship
- **WHEN** a model plan marks a relationship `hard` with confidence 0.95
- **THEN** it is recorded as soft with confidence 0.7

### Requirement: Default plan in engineering order

For every variant, a deterministic default plan SHALL be built without a model:
- **Phase membership:** each part goes to the earliest phase its critical classes name, otherwise to `remaining`.
- **Region hints:** a subsystem holding an edge connector or an RF module takes that edge; the rest take positions along the signal flow.
- **Orientations:** each anchor and support part faces the part or pin of its highest-weight relationship.
- **Groups:** displaced neighbourhoods that are legal among themselves move as rigid groups, and several capacitors on one pin form a group ordered by value.
- **Reference pull:** 0.5.

#### Scenario: The phase log follows the engineering order
- **WHEN** the default plan runs on a board with connectors, a regulator with decoupling, and pull-up resistors
- **THEN** the phase log lists `mechanical`, `regions`, `anchors`, `support`, `loops`, `separation`, `remaining` in that order, the connectors are in `mechanical`, the decoupling capacitors in `support`, and the pull-ups in `remaining`

### Requirement: Phased packing

The phase executor SHALL run the phases in order. Each packing phase SHALL be compiled into one packer input per board side:
- every part placed so far is static;
- released parts have their allowed rotations, with orientation hints tried first;
- rigid groups are composite parts;
- connection weights are the highest weight of each net's critical classes, with ground and rails at 0 and unclassified nets at 1;
- point attractors pull toward reference positions, region hints and critical pins;
- aggressor or sensitive extents are inflated by the isolation distance;
- keepouts are obstacles;
- the boundary is the outline inset by the copper-to-edge clearance.

The `support`, `loops` and `remaining` phases SHALL pack island subsystems first and then the board.

A failed phase SHALL retry in this order:
1. alternative orders;
2. a smaller gap;
3. release of `remaining`-phase or delta neighbours;
4. flat packing.

Parts still unplaced SHALL make the result `partial`, with `reuse.pack.unplaceable` naming them.

#### Scenario: Earlier phases stay put
- **WHEN** the `remaining` phase packs pull-up resistors
- **THEN** every part placed by `mechanical`, `anchors` and `support` has the same position and rotation it had after its own phase

#### Scenario: An unplaceable part is named
- **WHEN** a board leaves no legal position for one released part after every retry
- **THEN** the result status is `partial`, `unplacedComponentIds` names it, and `reuse.pack.unplaceable` gives the rotations tried and the closest rejection reason

### Requirement: Vendored geometry engine

The geometry engine SHALL be tscircuit calculate-packing at commit `a2d60ae` (MIT), vendored under `src/vendor/calculate-packing/`, without its tests, circuit-json plumbing and visualisation. `VENDORED.md` SHALL record the upstream commit, licence and patches.

The patches are:
- **P1:** local replacements for undeclared helper imports.
- **P2:** exact containment of collision boxes in the boundary polygon.
- **P3:** network weights that scale the distance cost.
- **P4:** no silent fallback placement of the first part.
- **P5:** failure detail naming the part, the rotations tried and the closest rejection reason.

The vendored code SHALL import nothing from `src/` outside itself, and SHALL be deterministic.

#### Scenario: A concave notch is respected
- **WHEN** the boundary outline has a notch and a candidate's box corners and pad centres lie inside the outline while its box crosses the notch
- **THEN** the candidate is rejected

#### Scenario: Weights scale attraction
- **WHEN** a part has two same-net partners at equal distance on opposite sides, and one net weighs 6 while the other weighs 1
- **THEN** the part is placed nearer the partner on the net weighted 6

#### Scenario: Same input, same output
- **WHEN** the packer runs twice on identical input
- **THEN** the placements are byte-identical

### Requirement: Variants, screening and options

The placer SHALL generate variants over:
- partition;
- clean-up;
- island split (`none` or split above 20 parts);
- packing strategy and order.

Each variant is identified by its key. The number of packing runs per plan SHALL be bounded (default 48).

Variants SHALL be screened in memory by `verifyDesign` and the tier vector without KiCad. Only the top 8 are materialised with KiCad, critical routing runs on the top 5, and the routability probe on the top 3.

The outcome SHALL present up to three options that differ in partition, subsystem arrangement, or at least 3 mm mean displacement. Each option SHALL carry its variant key, tier vector and a trade-off against option A.

#### Scenario: Only the top candidates touch KiCad
- **WHEN** 30 variants are packed
- **THEN** at most 8 are materialised, at most 5 are routed on critical nets, at most 3 are probed, and the rest carry only in-memory results

#### Scenario: Options are distinct
- **WHEN** the top two candidates have the same partition, the same subsystem order and 0.4 mm mean displacement between them
- **THEN** the second is not presented as option B, and the next distinct candidate is

### Requirement: Critical routing and revision

The critical nets of a candidate SHALL be:
- the nets of its `hot-loop`, `supply-decoupling`, `bootstrap` and `output-chain` relationships;
- power nets;
- nets the intent or the routing classification marks critical.

They SHALL be routed with `routeBoard({ netNames })`, the return-path checker SHALL run, and the routed copper SHALL NOT be kept.

Up to 3 revision cycles SHALL apply deterministic rules first:
- rotate parts to face each other;
- swap equal-footprint support parts;
- release and repack `remaining` parts lying between the pads.

Then, when a model is enabled, a model reassessment runs. Each cycle re-executes from the earliest affected phase.

#### Scenario: Critical routing is measurement only
- **WHEN** a candidate's critical nets are routed
- **THEN** the candidate's board file carries no copper from that run, and `critical_completion` and `critical_detour_ratio` are recorded

#### Scenario: Facing parts fix an unrouted connection
- **WHEN** a seeded board places two parts of a decoupling relationship with their connected pads facing away, and the critical route fails
- **THEN** a revision rotates them to face each other, and the rerouted candidate completes that connection

### Requirement: Model planner

`placer-reuse-plan` SHALL make one tool-less `Provider.chat` call per round.
- **Input:** board and part summaries without coordinates beyond part positions; subsystem variants; rule-derived relationships; cached datasheet facts with citations; the reference transfer and delta table; the default plan and its screened tier vectors.
- **Output:** K plans (default 2), validated by the plan rules.
- **Rounds:** at most 1 planning round and 2 reassessment rounds.
- **Records:** every request and response is stored with the model id, template id, input hash and usage.
- **Replay:** reads responses by input hash and reproduces every candidate placement.
- **Registration:** the engine SHALL be registered only when `--model` is given.

#### Scenario: Replay needs no model
- **WHEN** a recorded model run is replayed with no provider configured
- **THEN** every candidate placement equals the recorded run's

#### Scenario: No model, no network
- **WHEN** `pcb reuse` runs without `--model`
- **THEN** no provider is constructed and no network call is made

### Requirement: Coordinate fallback

`placer-reuse-coordinates` SHALL run only with `--model` and without `--no-fallback`, and only when no candidate passes the placement gate with every part placed.
- **Parts:** only the best candidate's unplaced parts and the parts named in its gate findings.
- **Input:** those parts' courtyard boxes per rotation and their pad offsets, with every other part as an obstacle.
- **Output:** coordinates. An entry for a part outside that set SHALL be dropped and reported as `reuse.model.illegal-move`.
- **Loop:** the rule stages and `verifyDesign` run after every answer, for at most 3 rounds.
- **Result:** a separate candidate with provenance `model-coordinates`, ranked against the others like any candidate.

#### Scenario: A move outside the asked-for set is dropped
- **WHEN** the model returns a coordinate for a part that was placed and not named in the gate findings
- **THEN** that entry is dropped, `reuse.model.illegal-move` is reported, and the remaining entries are still applied

#### Scenario: No fallback without a model
- **WHEN** a run without `--model` ends with parts unplaced
- **THEN** `placer-reuse-coordinates` is not registered and the run ends on its best packed candidate

### Requirement: Reuse placer engines

Three placers SHALL implement the placer contract:
- `placer-reuse-copy`: the transferred copy; deterministic, no network.
- `placer-reuse-pack`: default plans over variants; deterministic, no network.
- `placer-reuse-plan`: model plans; nondeterministic, replayable, network required.
- `placer-reuse-coordinates`: model coordinates for stranded parts; nondeterministic, replayable, network required, registered only with `--model`.

Every candidate SHALL record its provenance:
- reference and target hashes;
- the match set and transform;
- the variant key and plan id;
- the phase log;
- the vendored packer commit and patches;
- the critical routing summary;
- the provenance of each part.

#### Scenario: Determinism without a model
- **WHEN** `placer-reuse-pack` runs twice on the same board, reference and seed
- **THEN** every candidate's placements are byte-identical

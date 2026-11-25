# pcb-layout-intent — Delta Spec

## ADDED Requirements

### Requirement: Layout constraints live in the one registry
Placement and routing constraints SHALL be entries in `.copperhead/constraints.json` carrying the existing `source` and `affects` fields plus `class` (mechanical, relative, electrical-layout, functional, thermal, emc, manufacturing, routing, stackup), `severity` (hard, soft, advisory), `scope`, `parameters`, `priority`, `confidence`, and `approvedBy`. There SHALL be no second constraint file. `record_constraint` SHALL accept the new fields and the dual-write obligation SHALL apply.

#### Scenario: Attachment constraint recorded (AC-17.8)
- **WHEN** the agent records "C12 within 2.0 mm of U1 VDD/GND" as a hard relative constraint
- **THEN** the registry entry carries class `relative`, severity `hard`, the scope naming C12 and U1's pins, `max_distance_mm: 2.0`, and the source document

### Requirement: ECAD-authored constraints are ingested first
On import the intent compiler SHALL ingest KiCad netclasses, `.kicad_dru` rules, locked footprints, and keepout zones into the registry with `source: ecad_rules`, `confidence: 1.0`, and a reference to the originating file; they SHALL be hard by default and outrank derived constraints. A derived constraint contradicting an ECAD rule SHALL be a `HOLD`.

#### Scenario: Netclass outranks a derived width
- **WHEN** the schematic-derived rule proposes 0.2 mm for a net whose netclass sets 0.3 mm
- **THEN** the registry holds the 0.3 mm rule as hard and the derivation is recorded as `HOLD` with both values

### Requirement: Functional blocks come from the subsystem partition
The intent compiler SHALL derive functional blocks deterministically from `docs/SUBSYSTEMS.md` and the per-part `group` assignments in `schematic.intent.json` before any model call, giving each block an anchor, a region assigned by signal flow, a spread budget derived from member courtyard areas, and a `functional.group` constraint in the registry. The model MAY add semantic roles and MAY propose splitting or merging blocks, and every accepted change SHALL be recorded as its own constraint with a justification and provenance. Placement SHALL run as the staged plan of RFC 11 §8.5 (fixed mechanicals, block anchors, rule-placed attachments, packing, probe) unless a placer declares support for grouped and region constraints, and the intent checker SHALL verify block spread and separation either way. The evidence bundle SHALL report compliance per block.

#### Scenario: Blocks mirror the schematic's groups (AC-17.18)
- **WHEN** `docs/SUBSYSTEMS.md` names three subsystems and every part's intent group names one of them
- **THEN** the registry holds exactly three `functional.group` constraints whose members equal the schematic's group memberships, each with an anchor and a spread budget, and no model call was needed to produce them

#### Scenario: Decoupling is placed by rule, not by the packer
- **WHEN** C12 carries a hard `relative.attached` constraint to U1's VDD and GND pins and the staged plan runs
- **THEN** C12's position is set in the attachment stage before the wrapped placer runs, the packer receives it locked, and the checker reports its pad-to-pad distance against the constraint

#### Scenario: Block spread is reported
- **WHEN** a block's members spread to 1.4 times its budget after placement
- **THEN** the intent checker emits a `functional.group` diagnostic with measured and allowed values and the evidence bundle's per-subsystem table shows the block over budget

### Requirement: Reference layouts are retrieved, cached, and licensed
Before the attachment stage, the framework SHALL search for reference layouts for every block anchor across manufacturer datasheets (through the datasheet cache and the RFC 4 pattern model), existing native-CAD designs (local corpora and, when online search is enabled, designs found online using the same part, footprint, or symbol), and RFC 1 teardown placement analyses; SHALL rank matches by similarity (part number above family or footprint above circuit pattern, with connector set and board class as tie-breakers and source authority last); SHALL cache every block in `.copperhead/layout-refs/` with source, retrieval date, content hash, license, score, and confidence; and SHALL apply a block only when its license is permissive or an approver is recorded, returning `HOLD` otherwise. An applied block SHALL become attachment and group constraints citing the block, so the intent checker verifies it and the evidence bundle names the reused design. Retrieval SHALL NOT be reachable from `check`.

#### Scenario: Datasheet arrangement becomes constraints (AC-17.19)
- **WHEN** U2's cached datasheet states that the input capacitor sits within 2 mm of VIN and draws the converter loop
- **THEN** the cache holds a `datasheet` block for U2 citing the page, the registry gains a hard attachment constraint for the input capacitor with `max_distance_nm` 2 000 000, and the loop members carry a group topology hint naming the block

#### Scenario: Copyleft design needs approval
- **WHEN** the best-scoring block for U1 comes from a CERN-OHL-S design found online
- **THEN** the block is cached with no approver, the run returns `HOLD` naming the block and its license, and after `pcb_find_references` records an approver the next run applies it

#### Scenario: Cache makes the run reproducible
- **WHEN** a repo with a populated layout-reference cache is laid out under the network guard
- **THEN** the same blocks are applied with no network request

### Requirement: Intent compiler
The compiler SHALL identify functional blocks and semantic roles, extract explicit requirements unmodified, derive candidate rules through the existing fact base with provenance, resolve conflicts by source authority and priority, mark uncertain or unsupported conclusions `HOLD`, produce a human-readable explanation and a machine-readable constraint set, and SHALL never silently downgrade a hard constraint. Intent files SHALL address components by refdes and the compiler SHALL resolve them to stable ids recorded in the snapshot.

#### Scenario: Hard constraint cannot be downgraded silently
- **WHEN** a repair action proposes relaxing a hard constraint
- **THEN** the run returns `HOLD` requesting approval and the constraint is unchanged

### Requirement: Physics compiler is advisory without complete inputs
The physics compiler SHALL translate electrical intent into geometry only when fabrication and environmental inputs are complete, recording method, inputs, uncertainty, and originating constraint. User-authored widths, clearances, and fabricator limits SHALL be hard gates; simplified current-width estimates SHALL be advisory; controlled impedance SHALL return `HOLD` without a validated stackup and approved model.

#### Scenario: Impedance without stackup holds
- **WHEN** a net carries a single-ended impedance target and the stackup class is absent
- **THEN** the compiler returns `HOLD` naming the missing stackup inputs

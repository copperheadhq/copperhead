# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Stage-3 parts manifest

The part-selection stage SHALL produce a parts manifest at `docs/parts.intent.json` with one entry per refdes. An active-part entry SHALL carry `ref`, `value`, `group`, `libId`, `footprint`, `mpn`, `rationale` and `verified`; a passive entry MAY give `package` in place of `libId` and `footprint`; any entry MAY set `offBoard`; an entry for a board feature with nothing to buy (a mounting hole, a fiducial, a pad test point) MAY set `noPart` in place of `mpn`; the manifest MAY list `substitutions`, each with `ref`, `wanted`, `chosen` and `reason`. The model authors the manifest; BOM.md is rendered from it and SHALL NOT be authored directly while a manifest exists.

#### Scenario: Passive entry needs no ids

- **WHEN** the manifest entry for `C3` gives `value` `4.7uF`, `package` `0603` and a group
- **THEN** validation accepts it and the render shows `Device:C` and `Capacitor_SMD:C_0603_1608Metric` for that row

#### Scenario: Off-board entry is accepted without a footprint

- **WHEN** an entry sets `offBoard: true` and gives no `libId` or `footprint`
- **THEN** validation accepts it, the rendered row is marked off-board, and neither the pre-schematic footprint stop nor populate nor drift reports it

#### Scenario: Board feature needs no MPN

- **WHEN** the entry for mounting hole `H1` gives `libId`, `footprint` and `noPart: true`, and no `mpn`
- **THEN** validation accepts it after checking its symbol, footprint and pads like any on-board part, and the rendered MPN cell reads `(no part)`

#### Scenario: A description is not a part number

- **WHEN** an entry sets `noPart: true` and also gives an `mpn`, or sets both `noPart` and `offBoard`
- **THEN** validation reports a finding naming the refdes and the two fields that contradict each other

### Requirement: Stage-3 completion is the validator's verdict

The part-selection stage SHALL be complete only when the manifest exists, validates clean against the installed symbol and footprint libraries of the machine running the pipeline, and BOM.md equals the manifest's render. A manifest with no parts SHALL NOT validate clean. The same validator SHALL answer the stage's completion check, a finish-time stage gate, and the contract-gap message, so the three never disagree. The completion check SHALL NOT read the MPN column, and the previous "at least one MPN not flagged UNVERIFIED" test SHALL be removed. A library that is not installed anywhere remains the user's stop and SHALL NOT be reported as a gap the model can fix.

#### Scenario: Finish refuses with the exact gap

- **WHEN** the model calls `finish` while an active part's `libId` does not resolve
- **THEN** finish is refused with a message naming the refdes, the lib_id, and the nearest installed lib_ids, and the run continues

#### Scenario: An empty manifest does not complete the stage

- **WHEN** the manifest's `parts` list is empty and BOM.md is its header-only render
- **THEN** the validator reports that the manifest lists no parts, `draft_bom` renders nothing, and part selection is not complete

#### Scenario: Flagged MPNs do not block completion

- **WHEN** every entry has `verified: false` and the manifest otherwise validates clean
- **THEN** the stage completes and every rendered MPN carries the UNVERIFIED flag

#### Scenario: Manifest-less resume completes on footprints alone

- **WHEN** a create run resumes with a BOM.md and no manifest, and every Footprint cell resolves
- **THEN** stage 3 is treated as complete without reading the MPN column

### Requirement: Stage 4 builds parts from the manifest

When a manifest exists, the schematic stage SHALL take each IR part's `libId`, `value`, `footprint` and `group` from the manifest entry of the same `ref`, SHALL omit off-board entries from the IR, and SHALL reject an IR part whose `ref` is absent from the manifest or whose fields differ from it. The stage-4 entry pin dossier SHALL resolve each manifest `libId` exactly and SHALL NOT name-match MPNs for entries that carry one. Without a manifest the stage keeps the BOM.md cross-check and the name-matching dossier.

#### Scenario: IR inherits verified ids

- **WHEN** the manifest records `U1` as `MCU_ST_STM32F1:STM32F103C8Tx` with a resolved footprint
- **THEN** the dossier lists exactly that symbol's pins for `U1`, and an IR part `U1` naming a different lib_id fails validation citing the manifest

#### Scenario: A manifest that does not parse is a finding

- **WHEN** `docs/parts.intent.json` exists but is not a valid manifest (truncated JSON, a wrong field type) and the schematic intent is validated
- **THEN** validation reports that the manifest is not valid, with the reason, and does not fall back to the BOM.md cross-check

### Requirement: Stage-3 prompt states the task, not the format

The part-selection prompt SHALL instruct the agent to choose parts per SUBSYSTEMS.md heading within the recorded budgets, write the manifest, call `draft_bom`, repair its findings, and finish. It SHALL NOT require per-part `search_symbols` or `symbol_pins` calls, SHALL NOT restate the table format, and SHALL direct a part the libraries cannot capture to a `substitutions` entry with a reason.

#### Scenario: No per-part probing is required

- **WHEN** the agent writes a complete manifest and `draft_bom` reports clean on the first call
- **THEN** the stage can finish without any `search_symbols` or `symbol_pins` call having been made

### Requirement: Stage 3 availability probing

_Supersedes the requirement of the same name from `add-symbol-pin-dossier`; stated as ADDED because no main `create-pipeline` spec exists yet to modify._

The part-selection stage SHALL establish that every active part is capturable and drawable on this machine before the stage completes: its symbol exists in an installed library, its footprint resolves, and its symbol's pins are pads of that footprint. These facts SHALL be established by the manifest validator and reported as findings naming the refdes and the nearest installed alternatives, not required as agent tool calls. `search_symbols` and `symbol_pins` remain available for the agent's own exploration. A multi-unit symbol is accepted, matching the drafting engine's current behaviour of placing each unit under the one refdes.

#### Scenario: Missing symbol is a finding, not a dead end

- **WHEN** an entry's `libId` names a symbol installed under another library
- **THEN** `draft_bom` reports the entry with the lib_id where the symbol actually lives, and the stage does not complete until the entry is corrected

#### Scenario: Pad mismatch is caught before the schematic stage

- **WHEN** an entry's symbol has a pin its footprint has no pad for
- **THEN** `draft_bom` reports the mismatch for that refdes with the same advice the IR validator gives today, and the stage does not complete until the pair agrees

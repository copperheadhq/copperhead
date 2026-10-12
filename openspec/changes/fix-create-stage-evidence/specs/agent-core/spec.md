# Agent verification evidence

## Purpose

Distinguish verified generated definitions and actual export files from labels or prefixes that do not establish a valid artifact.

## ADDED Requirements

### Requirement: Explicit installed ESP-IDF build evidence

When the operator selects installed ESP-IDF SDK/tools paths, the agent SHALL have an OpenSpec-gated build_firmware capability on isolated source copies. Completion and resume SHALL require successful nonempty binaries matching current firmware, PINOUT and toolchain identity. Without explicit selection, the default catalog and legacy behavior SHALL remain unchanged.

#### Scenario: Available compiler is not executable from the default catalog

- **WHEN** the operator explicitly selects the installed ESP-IDF adapter
- **THEN** the validated firmware stage SHALL be able to obtain actual build diagnostics and repair its sources through normal tools
- **AND** a failed or stale build SHALL block finish and resume advancement
- **AND** evidence SHALL include application ELF/bin, bootloader and partition binaries
- **AND** it SHALL NOT install dependencies, flash hardware or treat source presence as compilation
- **AND** managed compiler intermediates SHALL remain ignored; previously tracked copies SHALL be untracked without deleting evidence or rewriting history

#### Scenario: Reproducibility is explicitly required

- **WHEN** create is invoked with firmware-reproducible
- **THEN** two independent real builds SHALL produce identical nonempty ELF/bin outputs before completion
- **AND** a version string or a claimed receipt boolean alone SHALL NOT establish reproducibility

### Requirement: Exact generated power definition verification

The symbol verifier SHALL compare reserved generated power definitions against the engine's complete canonical parsed templates. PWR_FLAG SHALL retain its dedicated definition. A prefix alone SHALL never exempt a definition, and ordinary installed-library comparison SHALL remain in force.

#### Scenario: Valid named rails stay distinct

- **WHEN** VBUS_RAW and +5V_PROTECTED definitions exactly match their engine templates
- **THEN** verification accepts them without rewriting the schematic or collapsing net names

#### Scenario: Reserved-prefix counterfeit

- **WHEN** a reserved-prefix definition changes metadata, graphics or pins, or contains an arbitrary component body
- **THEN** verification reports a blocking generated-symbol finding instead of skipping an unavailable library

### Requirement: Fresh export file inventory

Fabrication exports SHALL retain stable artifact labels and separately report actual relative paths and byte sizes. Each job SHALL verify fresh nonempty regular files of the expected format before reporting success. Old files, empty directories and a zero exit code alone SHALL not establish success.

#### Scenario: Directory DXF and multiple SVG pages

- **WHEN** KiCad writes a DXF under an output directory and one SVG per schematic page
- **THEN** the inventory reports every actual file path and size rather than inventing a single schematic.svg path

#### Scenario: Successful exit with no output

- **WHEN** an exporter exits zero but creates no matching nonempty regular file
- **THEN** that artifact is reported failed even if earlier output files remain

#### Scenario: Known destination conflict

- **WHEN** a later destination in a multi-file job is a directory or symbolic link
- **THEN** all destinations are checked before any existing file in that job is replaced
- **AND** no claim of transaction atomicity against arbitrary disk failure is made

### Requirement: Track unexpected post-write probe failures

Unexpected post-write loadability validation failures in edit_file and move_footprint SHALL register the affected file and invalidate its cached verification before attempting restoration. The handler SHALL report failure even after successful restoration, preserve existing obligations, and require fresh verification. Restoration failure SHALL report both errors and keep mutation obligations open.

#### Scenario: Probe exception after a write

- **WHEN** a loadability probe throws after a schematic edit, board edit or footprint move
- **THEN** the handler restores the original bytes where possible and reports failure
- **AND** the affected file remains tracked with stale verification cleared and outstanding obligations preserved

#### Scenario: Restoration also fails

- **WHEN** restoration fails after a post-write validation exception
- **THEN** both failures are reported and the possibly retained modification remains tracked

#### Scenario: Normal rejection and incremental repair

- **WHEN** a completed probe normally rejects an edit and restores valid original bytes
- **THEN** prior verification and obligations remain unchanged
- **AND** the existing incremental repair behavior for an already-unloadable file is preserved

### Requirement: Truthful Codex stream progress and cancellation

The Codex adapter SHALL forward actual new agent-message or reasoning-summary text from SDK stream events to the loop progress callback. Lifecycle events, unchanged text and timer heartbeats SHALL NOT count as progress. A completed turn SHALL still require a valid structured response and turn.completed. The SDK AbortSignal SHALL remain connected to provider close and watchdog cancellation. A client without streaming support SHALL remain under its nonstreaming deadline without invented activity.

#### Scenario: Growing SDK text prevents false idle timeout

- **WHEN** the SDK emits new text before the idle deadline
- **THEN** the adapter reports actual cumulative character growth and resets the idle watchdog
- **AND** the hard limit remains active

#### Scenario: Silence or lifecycle-only events

- **WHEN** the SDK emits only startup notifications or stops producing text
- **THEN** those events do not extend the idle deadline and timeout aborts the iterator

#### Scenario: Truncated stream and cancellation

- **WHEN** a stream ends without turn.completed or the provider is closed
- **THEN** no successful structured turn is reported and SDK cancellation/iterator cleanup remains active

### Requirement: Ordering BOM table and reference compatibility

Ordering BOM tables SHALL retain individual references and table-local headers.
Generic references may be descriptive; explicit JLC retains canonical references.
Grouped, duplicate, unsafe references and missing orderable-part MPNs SHALL fail.
Supporting budget tables, repeated headers and fenced examples are not parts.

#### Scenario: Separate parts tables with descriptive references

- **WHEN** a generic export reads `U_MCU` and `R_GO_T5` from separate parts tables with independently reordered headers
- **THEN** the ordering CSV SHALL retain both exact references and MPNs with quantity one
- **AND** supporting tables, repeated headers and fenced examples SHALL not become component rows

#### Scenario: Invalid ordering rows cannot complete the pipeline

- **WHEN** a BOM contains duplicate or grouped references, or missing MPNs
- **THEN** generic board exports MAY finish with an explicit missing-ordering-BOM warning
- **AND** Stage 6 SHALL remain incomplete

#### Scenario: Explicit JLC reference checks remain bounded

- **WHEN** the explicit JLC profile receives a descriptive reference outside its canonical letter-plus-number format
- **THEN** it SHALL fail explicitly without silently selecting the generic profile

### Requirement: Automatic population preserves reference clearance

With explicit clearance mode, automatic population SHALL position visible reference fields outside intrinsic
footprint bounds and reserve conservative actual stroke-font text bounds. It
SHALL preserve pads, graphics, keepouts and hidden reference metadata; DRC remains
a required pre-layout gate, not a warning suppressed to permit a run.

#### Scenario: Descriptive reference and colliding library default

- **WHEN** an installed footprint has a visible reference over its pads or graphics and receives a long descriptive reference
- **AND** create explicitly selects clearance mode
- **THEN** population SHALL place the reference above the intrinsic bounds and reserve its actual text range during packing
- **AND** only instance text metadata SHALL change while original pads, graphics and keepouts remain intact

#### Scenario: An intrinsic copper defect remains a blocker

- **WHEN** population produces a board with an intrinsic copper clearance violation
- **THEN** pre-layout DRC SHALL still reject the board and restore the last verified board

#### Scenario: Existing reference placement remains compatible

- **WHEN** create has no explicit reference placement mode or selects library mode
- **THEN** population SHALL preserve the prior library field metadata and packing
- **AND** an explicitly selected mode SHALL remain in the printed resume command

### Requirement: Part selection gives finish-time field feedback

Part-selection finish SHALL enforce the existing selected-MPN and footprint
contract before committing. The stage prompt SHALL put the actual MPN alone
in its column and preserve the UNVERIFIED qualification in Rationale.

#### Scenario: Every MPN has an UNVERIFIED prefix

- **WHEN** all selected MPN fields begin with UNVERIFIED
- **THEN** finish SHALL name the MPN field defect before committing
- **AND** it SHALL direct repair of the column while retaining qualification in Rationale

#### Scenario: Qualification remains explicit after repair

- **WHEN** a real selected MPN is in its column and Rationale flags it UNVERIFIED
- **THEN** the existing selected-MPN contract SHALL accept that selection without claiming procurement readiness
- **AND** footprint checks and post-run completion checks SHALL remain active

### Requirement: Final stage has its own reviewed document commit

Create SHALL resume past devplan only when the current nonempty plan matches
its latest file-changing normal devplan-stage commit.

#### Scenario: Firmware wrote a candidate plan

- **WHEN** DEVPLAN was committed by firmware and has no matching devplan-stage commit
- **THEN** create SHALL preserve that candidate and run the normal final-stage review
- **AND** completed earlier stages SHALL remain skipped
- **AND** finish SHALL require an actual plan change before normal verification and commit

#### Scenario: Reviewed plan resumes or becomes stale

- **WHEN** the current plan matches its normal file-changing devplan-stage commit
- **THEN** create SHALL skip the final stage on resume
- **AND** a later plan change or an empty stage-labelled commit SHALL NOT establish final-stage completion

### Requirement: Generated power verification tolerates known save defaults

Generated-power verification SHALL compare complete known definitions after
normalizing observed KiCad9/10 default serialization and supported historical graphics.

#### Scenario: Genuine symbol after KiCad upgrade

- **WHEN** KiCad saves a known generated definition with global-power spelling, default properties, hide spelling or reordered children
- **THEN** verification SHALL accept it read-only
- **AND** known pre-71c10ed graphics SHALL remain recognized
- **AND** changed pins, meaningful metadata or arbitrary geometry SHALL still fail
- **AND** diagnostic guidance SHALL NOT instruct blind replacement of intentional user changes

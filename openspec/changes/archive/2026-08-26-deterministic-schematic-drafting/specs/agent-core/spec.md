# agent-core — Delta Spec

## ADDED Requirements

### Requirement: `check_legibility` tool

The tool list SHALL include `check_legibility`, available in the same phase as `verify_symbols` and taking no required arguments. It SHALL run the deterministic legibility checker against the configured schematic and return either a statement that no findings exist or a numbered list of findings, each naming its kind, severity, sheet, coordinates, affected references, and the concrete fix. References are the finding's `refs` and are not limited to refdes: a `group-overlap` finding names the two group captions, `empty-title-block` names the empty fields, and page-level findings such as `low-utilization` name the sheet, so a finding with no symbol involved still says what it is about. When no schematic is configured, it SHALL say so rather than failing.

#### Scenario: Clean schematic

- **WHEN** the agent calls `check_legibility` against a schematic with no defects
- **THEN** the result states the sheet count checked and that there are no findings

#### Scenario: Findings are actionable

- **WHEN** the checker finds overlapping symbol bodies
- **THEN** the result numbers the finding, names both refdes and their coordinates, and states the minimum separation required

#### Scenario: No schematic configured

- **WHEN** `check_legibility` runs in a repo whose config names no schematic
- **THEN** the result states that no schematic is configured and the run continues

#### Scenario: Non-symbol finding is still actionable

- **WHEN** the checker finds an empty title block
- **THEN** the numbered finding names the empty fields as its references and states what to fill in, with no refdes required

### Requirement: `check_legibility` joins the verification sequence

The agent loop's stated workflow SHALL include `check_legibility` in the verification steps that precede `finish`, alongside ERC, DRC, and the drift check: after schematic edits, the prompt SHALL direct the agent to run `check_legibility` and reconcile error-severity findings in the same loop that already requires a clean ERC, rather than leaving the checker as a tool the agent may never call.

#### Scenario: Prompt names the checker before finish

- **WHEN** the agent loop's prompt states the verification steps a schematic-editing run must complete before `finish`
- **THEN** `check_legibility` is listed with `run_erc` and `check_drift`, with the instruction to reconcile error-severity findings

### Requirement: Legibility findings feed the sync-obligations ledger

On repos whose schematic copperhead authored (create origin), an error-severity legibility finding outstanding at the time `finish` is called SHALL be reported by `finish` as an unmet obligation, in the same list that already carries drift, constraint dual-write, and verification obligations. On repos with a hand-drawn schematic (init-ed or hand-maintained), the obligation SHALL NOT open: a pre-existing sheet could never satisfy the standard without a full redraw, so the same findings reach the agent and `check` as advisory information only, matching the check-reports-create-gates split. The obligation SHALL follow the ledger's existing edit-reopens, clean-run-clears lifecycle: a schematic mutation, whether an anchored edit or a `draft_schematic` run, opens (or re-opens) the legibility obligation through the same post-tool-call hook that re-opens the ERC and drift obligations, a `check_legibility` run with zero error-severity findings clears it, and a run with error-severity findings leaves it open carrying the current finding list. "Outstanding" therefore always means the most recent checker result against the file as edited, never a stale finding list, and `finish` and the stage-completion recheck judge the same state.

A gate scoped by a marker is only as real as the marker's writer, so `create` SHALL write `origin: "create"` into `.copperhead/config.json` itself: once at the start of every run (covering resumed repos whose project predates the marker) and again on every project scaffold (covering the rollback path, where `git clean` deletes an uncommitted config). A repo produced by a real `create` run SHALL therefore always satisfy the create-origin predicate this requirement scopes by.

The gate SHALL additionally require that the configured schematic is still copperhead-authored, detected by the generator stamp every copperhead-written sheet carries (the bootstrap scaffold and every engine draft). A human taking the sheet over in KiCad re-saves it under KiCad's own generator, and from that moment the obligation SHALL NOT open: the drawing is no longer the engine's to regenerate, so wedging `finish` on its legibility would demand geometry work the IR cannot express. A create repo whose schematic is not yet scaffolded SHALL keep the gate, since the sheet stage 4 will produce is copperhead-authored by construction.

#### Scenario: Hand takeover releases the gate

- **WHEN** a create-origin repo's schematic has been re-saved by KiCad (the copperhead generator stamp is gone) and a later run edits the repo
- **THEN** the legibility obligation does not open, and findings reach the agent and `check` as advisory information only

#### Scenario: A real create run is create-origin

- **WHEN** `create` scaffolds or resumes a project and any stage begins
- **THEN** `.copperhead/config.json` carries `origin: "create"`, so the legibility obligation lifecycle above is live rather than silently inert

#### Scenario: `finish` refuses while the sheet is illegible (AC-16.24)

- **WHEN** the agent calls `finish` with outcome "done" while error-severity legibility findings remain
- **THEN** `finish` lists the outstanding findings as unmet obligations and the run does not conclude as done

#### Scenario: Clean rerun clears the obligation

- **WHEN** error-severity findings were recorded, the agent revises the sheet to fix them, and `check_legibility` runs again with zero error-severity findings
- **THEN** the legibility obligation is cleared and `finish` no longer lists it

#### Scenario: Draft re-opens the obligation

- **WHEN** `check_legibility` has run clean and the agent then mutates the schematic again, by anchored edit or by re-draft
- **THEN** the legibility obligation re-opens and stays open until the checker runs clean against the new file

#### Scenario: Hand-drawn repos are informed, never wedged

- **WHEN** `copperhead do` edits the schematic of a repo copperhead did not create and the sheet has error-severity legibility findings
- **THEN** `check_legibility` reports the findings but no legibility obligation opens, and `finish` does not refuse on them

### Requirement: `draft_schematic` tool

The tool list SHALL include `draft_schematic` in the schematic stage, taking the netlist-intent IR (inline or as a path to `schematic.intent.json`). It SHALL validate the IR, run the deterministic drafting engine, write the schematic, and return the draft report (groups placed, wire and label counts, resolved net classes, synthesized `PWR_FLAG`s, and the embedded legibility findings and score for the drafted sheet) or the numbered validation finding list on failure, so drafting, checking, and scoring cost one tool call. The embedded checker result SHALL update the legibility ledger obligation exactly as a `check_legibility` run would. A failed draft SHALL leave the previous schematic untouched. The tool SHALL be subject to the same spec-gating as the other mutating tools: structurally absent until the change proposal validates.

#### Scenario: Successful draft

- **WHEN** the agent calls `draft_schematic` with a valid IR
- **THEN** the schematic is fully regenerated from the IR and the result reports what was placed

#### Scenario: Invalid IR fails without side effects

- **WHEN** the agent calls `draft_schematic` with an IR referencing an unknown pin
- **THEN** the result is the numbered finding list and the schematic file on disk is unchanged

#### Scenario: Drafting is spec-gated

- **WHEN** no validated OpenSpec proposal covers the change
- **THEN** `draft_schematic` is absent from the tool list, not present-but-refusing

### Requirement: `score_schematic` tool

The tool list SHALL include `score_schematic`, available in the same phase as `check_legibility`, taking no required arguments. It SHALL run the deterministic scorer against the configured schematic and return the composite, the per-metric breakdown, and any cap applied by error-severity legibility findings. When no schematic is configured, it SHALL say so rather than failing.

#### Scenario: Score with breakdown

- **WHEN** the agent calls `score_schematic` against a drafted sheet
- **THEN** the result states the composite and each metric's value, weight, and contribution

#### Scenario: No schematic configured for scoring

- **WHEN** `score_schematic` runs in a repo whose config names no schematic
- **THEN** the result states that no schematic is configured and the run continues

### Requirement: Geometry edits are refused in drafting mode

While the schematic stage is in drafting mode (the sheet is engine-authored from an IR), `edit_file` and `write_file` calls targeting the drafted schematic SHALL be refused with a message directing the agent to revise the IR and call `draft_schematic` instead. Schematics not authored by the engine, including all `copperhead do` edits to existing human-drawn sheets, SHALL keep the current anchored `edit_file` path unchanged.

#### Scenario: Hand edit is redirected to the IR (AC-16.23)

- **WHEN** the agent calls `edit_file` against an engine-drafted schematic during the schematic stage
- **THEN** the call is refused naming `draft_schematic` as the correct path, and no file change occurs

#### Scenario: Human-drawn sheets are unaffected

- **WHEN** `copperhead do` edits a schematic that was not engine-drafted
- **THEN** `edit_file` behaves exactly as it does today

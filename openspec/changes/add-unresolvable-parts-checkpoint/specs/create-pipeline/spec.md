# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Stage-4 unresolvable-parts checkpoint

Once per schematic-stage entry — after the resume check, before the first attempt's agent turn — the pipeline SHALL resolve the BOM against the installed symbol libraries using the same classifier the dossier renders from, and compute the genuine absence set: parts classified absent after both the MPN search and the Value fallback. The resolution/render split introduced for this SHALL NOT change the rendered dossier block by a single byte, and no consumer SHALL derive absence from rendered dossier text.

For each genuinely absent part the checkpoint SHALL gather nearest installed candidates via a looser suggestion search, bounded like the existing search. Suggestions MAY include digit-sibling family variants the dossier's match ranking refuses: a suggestion offered to a human is not a match claim made to an agent. The suggestion search SHALL run only for the checkpoint, never on the advisory dossier path.

When a checkpoint prompt is available (`create --interactive` on an attended terminal) and the absence set is non-empty, the pipeline SHALL pause before the first schematic agent turn, presenting each absent part with its refdes and query, its nearest candidates (or an explicit no-near-matches note), and any never-checked parts labeled as such, and SHALL offer three decisions: re-check (re-read `docs/BOM.md` and re-resolve, repeating the checkpoint against the fresh result), continue (proceed to the agent, which still receives the dossier), or stop. Cancelling the prompt SHALL mean stop: the safe default spends nothing.

When no prompt is available, the `unresolvableParts` config policy applies: `'agent'` (the default) SHALL proceed exactly as today, preserving run-to-completion; `'stop'` SHALL end the run before the first schematic agent turn with a nonzero exit, a stdout report naming each absent part with refdes, query, and candidates, the exact resume command, and a machine-readable `.copperhead/runs/unresolved-parts.json` written best-effort. An available prompt SHALL take precedence over `'stop'`: a present human is always asked instead of the run failing.

The checkpoint SHALL fire only on a successful resolution with a non-empty absence set. A degraded resolution — no readable library, timeout, or error — SHALL proceed with a warning that availability could not be verified, in both modes: "could not check" and "checked and absent" are different facts, and under `'stop'` the difference is a killed run. Parts disclosed as unresolved-by-error, not-searched, or past the size cap SHALL never trigger the checkpoint, and every checkpoint report SHALL list them explicitly as never actually checked.

An unknown `unresolvableParts` value SHALL fall back to `'agent'`; a config typo cannot crash or stop a run.

#### Scenario: Genuine absence stops a 'stop'-configured run before any agent turn

- **WHEN** `unresolvableParts` is `'stop'`, no checkpoint prompt is available, and at least one BOM part matches no installed symbol under its MPN or Value
- **THEN** the pipeline exits nonzero before the first schematic-stage agent turn, naming each absent part with its refdes, query, and nearest installed candidates, printing the resume command, and writing `.copperhead/runs/unresolved-parts.json`

#### Scenario: A degraded resolution never stops the run

- **WHEN** `unresolvableParts` is `'stop'` but no symbol library is readable, resolution times out, or resolution errors
- **THEN** the schematic stage proceeds exactly as today, with a warning that symbol availability could not be verified

#### Scenario: Never-checked parts never trigger the checkpoint

- **WHEN** the only incomplete parts are disclosed as unresolved-by-error, not-searched, or past the size cap, and none is classified absent
- **THEN** no stop and no pause occurs, and any emitted report lists those parts explicitly as never actually checked

#### Scenario: Interactive pause with a re-check loop

- **WHEN** `create --interactive` runs on an attended terminal and the absence set is non-empty
- **THEN** the pipeline pauses before the first schematic agent turn showing each absence and its candidates; choosing re-check re-reads `docs/BOM.md` and re-resolves; choosing continue proceeds to the agent; choosing stop (or cancelling) exits with the same report as `'stop'`

#### Scenario: No absences, no pause

- **WHEN** `create --interactive` runs and every searched part resolves to an installed symbol
- **THEN** no pause occurs and a one-line confirmation is logged

#### Scenario: A present human beats fail-fast

- **WHEN** `unresolvableParts` is `'stop'` and a checkpoint prompt is available and absences exist
- **THEN** the human is asked instead of the run failing

#### Scenario: The default preserves run-to-completion

- **WHEN** `unresolvableParts` is absent or `'agent'` and `--interactive` is not passed
- **THEN** stage-4 entry behavior is byte-identical to today: the absence list reaches the agent through the dossier and nothing pauses or stops

### Requirement: create forwards the interactive confirm gate

`create` (and `demo`) SHALL forward a real TTY confirm callback into the agent loop when `--interactive` is passed on an attended terminal, so the spec-approval gate prompts instead of silently auto-approving through the loop's always-true default. Off-TTY, no callback is forwarded and gates behave as in autonomous runs. The `--interactive` help text and documentation SHALL name the gates it re-enables accurately.

#### Scenario: The spec-approval gate actually prompts

- **WHEN** `create --interactive` runs on an attended terminal and a stage's proposal validates
- **THEN** the loop's confirm callback is the TTY prompt, and declining leaves edit tools locked, as the agent-core gate specifies

## MODIFIED Requirements

### Requirement: Stage-4 entry pin dossier

Before each attempt of the schematic stage runs, the pipeline SHALL resolve every BOM part against the installed symbol libraries and inject the result into the stage prompt as a machine-verified dossier, so the agent starts with the pin facts it would otherwise spend turns reconstructing. Resolution SHALL search the part's MPN first and, only when that search returns no match, SHALL search its Value as a separate fallback query — a bogus MPN over a resolvable Value must not read as absence. Matching SHALL include single-edit family variants (an MPN of `STM32F103C8T6` finds the stock `STM32F103C8Tx`; a digit-for-digit substitution is never a match), so a family-suffix spelling is not reported absent. A part whose only name is too short to search reliably SHALL be disclosed as not searched rather than silently dropped. Resolution SHALL be recomputed per attempt, since a rolled-back retry can run against a different BOM than its predecessor.

For each covered part the dossier SHALL name the part's refdes and query, the top-ranked installed lib_id, and that symbol's real pins (number, name, electrical type), following `extends` links. A symbol defining more than one unit SHALL be flagged as one the drafting engine refuses. Alternative candidate lib_ids SHALL be listed so a wrong top match is recoverable without a search turn. A part no installed symbol matches SHALL be named as such, with the instruction to substitute, rather than omitted.

Pure-passive refdes classes (R, C, L) are drawable from their canonical `Device:*` symbols and SHALL be omitted by design.

The dossier SHALL be bounded in size, and the bound covers the complete rendered block: parts beyond it SHALL be named as not included — with the instruction to fetch them via `symbol_pins` — never silently dropped, and the disclosure lines themselves SHALL fit within the bound, truncating their enumeration to an explicit count ("…and N more") rather than exceeding it, so coverage stays explicit even when the disclosure is cut short. Absence from the dossier is never readable as absence from the libraries.

Failures SHALL be reported for what they are: a part whose probe errored SHALL be disclosed as unresolved-by-error — distinct from the size-cap disclosure, since an error is not a size decision and says nothing about availability — while a failure of dossier construction as a whole SHALL yield no block at all. Failure of dossier or resolution construction SHALL NOT block the stage: on any error, on timeout, or when no BOM exists, the stage runs with no dossier block, exactly as before this change. The only sanctioned gates on the resolution result are the opt-in stage-4 unresolvable-parts checkpoint paths (`--interactive` pause, `unresolvableParts: 'stop'`), which fire solely on a successful resolution's genuine absence set — never on a degraded or partial one.

A NO-INSTALLED-SYMBOL line is an absence claim, and the dossier SHALL make one only after at least one library was actually readable: when no `.kicad_sym` resolves in any search directory, the machine has verified nothing, and the dossier SHALL be omitted entirely rather than assert absence for every part. "Could not check" and "checked and absent" are different facts, and a block labeled machine-verified must never render the first as the second.

#### Scenario: Covered part needs no discovery turns

- **WHEN** the BOM names a part whose symbol is installed
- **THEN** the stage-4 prompt already contains its lib_id and full pin table, and the agent can author `REF.PIN` endpoints without reading any `.kicad_sym`

#### Scenario: Genuinely absent part is surfaced at entry

- **WHEN** a BOM part matches no installed symbol under its MPN or Value
- **THEN** the dossier says so on the part's own line, so substitution starts on turn 1 instead of after a failed draft

#### Scenario: Size overflow is disclosed

- **WHEN** the rendered dossier would exceed its size bound
- **THEN** the parts left out are named as not included, with `symbol_pins` given as the way to fetch each, and the complete block — disclosure included — still fits within the bound, ending the enumeration with an explicit "…and N more" count when the names alone would not fit

#### Scenario: A probe error is not a size decision

- **WHEN** one part's search or resolution throws while the rest of the dossier builds
- **THEN** that part is disclosed as unresolved by error, separate from the size-cap disclosure, and the rest of the dossier renders normally

#### Scenario: Dossier failure does not block the stage

- **WHEN** the BOM is missing or dossier construction throws
- **THEN** the stage prompt is exactly the pre-change prompt and the stage proceeds

#### Scenario: An unreadable library yields silence, not false absence

- **WHEN** no symbol library is readable in any search directory
- **THEN** no dossier is injected at all — the block never claims NO INSTALLED SYMBOL for parts the machine could not actually check

#### Scenario: A family-variant MPN is not reported absent

- **WHEN** a BOM row names `STM32F103C8T6` and the installed library holds only the family symbol `STM32F103C8Tx`
- **THEN** the dossier resolves the row to the family symbol's lib_id and pins instead of claiming NO INSTALLED SYMBOL

#### Scenario: A name too short to search is disclosed

- **WHEN** a BOM row's only name is shorter than the search minimum (a crystal valued `8M` with no MPN)
- **THEN** the row is listed as not searched, so its absence from the dossier is never read as checked-and-absent

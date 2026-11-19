# structured-part-selection: Proposal

## Why

Part selection (create stage 3) uses the model as a loop driver over the KiCad libraries and then discards what it learned: the prompt demands `search_symbols` and `symbol_pins` per active part and `check_footprints` per footprint, enforces that only as prompt text, records none of the resolved lib_ids in BOM.md, and gates completion on a proxy read positionally off a markdown table (an MPN cell not starting with `UNVERIFIED`, which the same prompt tells the model to write). Stage 4 then recomputes every lookup as the pin dossier and re-guesses the symbol by name. Measured on a 283-part board (#446) the stage needed 104 turns and failed two of three attempts; on any board it can wedge on a flagged MPN, an off-board BOM line, or a reordered column, with a generic "no usable artifact" message that the retry diagnosis cannot act on. Full audit in #459.

## What Changes

- **New stage-3 artifact `parts.intent.json`** beside `schematic.intent.json`: one entry per refdes with `ref`, `value`, `group`, and for active parts `libId`, `footprint`, `mpn`, `rationale`, `verified`; passives give `package` only; off-board items set `offBoard`; forced swaps go in `substitutions` with a reason. The model authors this file, not BOM.md.
- **New agent tool `draft_bom`** (mirrors `draft_schematic`): validates the manifest against this machine's installed libraries and, when clean, renders BOM.md deterministically. Findings name the refdes and the fix: schema and duplicate/grouped refdes, value-not-description, passive expansion from package to canonical `Device:*` symbol and stock footprint, lib_id resolution with nearest installed ids on a miss, footprint resolution with nearest ids, symbol pins against footprint pads (moved here from stage 4), group coverage against SUBSYSTEMS.md in both directions, substitution reasons, off-board exemptions, MPN presence. The `UNVERIFIED` flag becomes a rendering concern.
- **One validator behind every gate**: the stage completion predicate, a finish-time stage gate, and the contract-gap message all call the same function. Completion means the manifest validates clean and BOM.md equals its render. The positional MPN test is removed.
- **Stage 4 reads parts from the manifest** when present (ref, libId, value, footprint, group), so the model authors only nets and no-connects; the pin dossier resolves recorded lib_ids exactly instead of name-matching MPNs. The BOM.md cross-check stays for repos without a manifest.
- **BOM.md becomes a rendered document**: same five columns plus a Symbol column and a header line naming the manifest as its source; `check` reports a BOM.md that no longer matches its render as drift. Off-board rows are marked and exempt from footprint checks everywhere (the pre-schematic stop, populate, drift).
- **Library lookup cache** under gitignored `.copperhead/cache/`: symbol pin tables and footprint resolutions keyed by library file mtime, shared by `draft_bom`, the dossier, IR validation and `check`, and kept across a failed attempt's rollback.
- **Stage-3 prompt shrinks** to the design task: choose parts per subsystem within the budgets, write the manifest, call `draft_bom`, fix findings, finish. `search_symbols` and `symbol_pins` remain available for exploration but are no longer a per-part requirement.
- Repos without a manifest (anything not built by `create`, hand-written BOM.md) keep today's readers and gates unchanged.

Not in scope: the turn budget and per-attempt escalation (#446, #135, #139, #192, handled separately); fetching symbols that are not installed (#238); pattern rows (#276, though the manifest is where they would live).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `create-pipeline`: stage 3's contract becomes manifest-plus-validator with a finish-time gate; the footprint stop and populate honour off-board rows; stage 4 builds IR parts from the manifest and the dossier uses recorded lib_ids.
- `agent-core`: the tool list gains `draft_bom`; the stage-3 availability probing requirement is replaced by validator findings.
- `docs-memory`: BOM.md is rendered from the manifest when one exists, gains a Symbol column and off-board marking, and drift covers manifest-to-BOM.md agreement.
- `kicad-tooling`: symbol-pin and footprint lookups are cached by file mtime under `.copperhead/cache/`.

## Impact

- **Code**: new `src/kicad/parts/` (manifest schema, validator, passive expansion table, BOM.md renderer); `src/capabilities/handlers.ts` (`draft_bom`); `src/commands/create.ts` (stage-3 predicate, stage gate, gap detail, prompt; stage-4 manifest input and dossier call); `src/kicad/draft/ir.ts` (parts from manifest; pad check shared with the validator); `src/kicad/dossier.ts` (exact lib_id path); `src/kicad/symlib.ts` and `src/kicad/footprints.ts` (cache); `src/memory/drift.ts` and `src/commands/check.ts` (render-agreement item); `.gitignore` (`.copperhead/cache/`).
- **Specs**: SPEC.md §2.5 pipeline diagram and a new AC-18 block; the four delta specs above.
- **Tests**: validator fixtures per rule, renderer round-trip through `parseBomTable` and the drift readers, stage-3 gate paths (clean, model-fixable miss, uninstalled library, off-board row), stage-4 manifest input, cache hit/miss on mtime change.
- **Unchanged contracts**: `check` stays LLM-free and network-free; edit tools stay spec-gated (`draft_bom` requires unlock like `draft_schematic`); KiCad files are untouched by this change; no new dependency.

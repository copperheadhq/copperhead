# add-symbol-pin-dossier: Proposal

## Why

Stage 4 must author every net endpoint as `REF.PIN` with real library pin numbers, but nothing hands it a pin table. Its only oracle is reactive — "validation lists a part's actual pins when you name one that does not exist" — so pins are learned one failed guess at a time, or by reading `.kicad_sym` source never meant for that.

Measured on real runs (`lemondrop`, run-logs/2026-08-07T17-52-03, upstream #201): the best stage-4 run to date spent roughly 15 of its 19 turns — about 10 of 15 minutes — paging raw symbol-library geometry through `read_file` to recover pin names before its first successful draft. An earlier attempt invented a darker workaround: a probe draft naming one deliberately bogus pin per unproven part, so a single validation report would echo back every real pin list. Both are reconstructions of information the machine can produce deterministically, and the BOM that fixes the part list is frozen before the stage starts.

A related trap costs whole stage-attempts one step later: `search_symbols` proves a symbol exists but not that it is drawable. The drafting engine refuses multi-unit symbols by design, and an agent that substituted its way to `SN74LVC2G17` and then `PESD5V0L4UG` — both installed, both multi-unit — hit the refusal twice after the BOM was already doc-truth.

## What Changes

- **Pin dossier injected at stage-4 entry**: before the schematic stage's first agent turn, every BOM part is resolved against the installed libraries — the MPN searched first, the Value searched separately only when the MPN finds nothing, with single-edit family variants matched (`STM32F103C8T6` finds `STM32F103C8Tx`, never a digit-for-digit swap) — and the stage prompt gains a machine-verified block: the top-ranked lib_id per part, its real pin table (number, name, electrical type), a MULTI-UNIT flag where the engine would refuse the symbol, alternative candidate lib_ids, and an explicit NO-INSTALLED-SYMBOL line for parts nothing matches. Pure-passive refdes classes (R/C/L) are omitted by design; their canonical `Device:*` symbols are already known. The block is recomputed per stage attempt, since a rollback can change the BOM underneath a retry.
- **Coverage is stated, never implied**: the dossier is size-capped over the complete rendered block, and parts past the cap are named as NOT INCLUDED with the instruction to fetch them via `symbol_pins` — the same disclosure contract `symbolAvailabilityFacts` established. The disclosure lines themselves fit within the cap, truncating their enumeration to an explicit "…and N more" count, so coverage stays explicit even when the disclosure is cut short; a part whose probe errored is disclosed as UNRESOLVED, and a part whose only name is too short to search is disclosed as NOT SEARCHED, both distinct from the size cap. An empty or failed dossier degrades to no block at all; it is advisory context and never blocks the stage.
- **New agent tool `symbol_pins`**: takes a lib_id, returns the resolved symbol's pin table and unit count, warning when the symbol is multi-unit. On a miss it returns the closest names within the guessed library plus cross-library matches, so one call answers both "what are the pins" and "where does it actually live". Read-only, no unlock, available alongside `search_symbols`.
- **Stage 3 confirms drawability, not just existence**: the part-selection prompt now requires `symbol_pins` on each chosen symbol to confirm it is single-unit, closing the exists-but-refused gap while a substitution still costs one BOM row.

## Capabilities

### Modified Capabilities

- `agent-core`: the tool list gains `symbol_pins`.
- `create-pipeline`: stage 4's prompt contract gains the entry dossier; stage 3's prompt contract extends its availability requirement to single-unit drawability.

## Impact

- **Code**: `src/kicad/symlib.ts` (`resolveLibrarySymbol` additionally reports the unit count); `src/kicad/dossier.ts` (new: `bomSymbolDossier`); `src/agent/tools.ts` (the `symbol_pins` schema and handler); `src/commands/create.ts` (stage-4 dossier injection, stage-3 and stage-4 prompt text).
- **Tests**: `test/dossier.test.ts` covers resolution via MPN and Value, the passive omission, the no-symbol line, the multi-unit flag, the size-cap disclosure, and the `symbol_pins` tool paths.
- **Unchanged contracts**: everything here is read-only and network-free, so `check`/`verify` stay LLM-free and network-free; spec-gating of edit tools is unaffected; no config, no new dependency; the dossier changes prompt content only — no gate tightens or loosens.
- **Not in scope**: enforcing dossier coverage as a stage gate (fuzzy MPN-to-symbol matching would refuse valid BOMs — same reasoning as add-symbol-search-tool); carrying failed work into retries (tracked separately as harness R6).

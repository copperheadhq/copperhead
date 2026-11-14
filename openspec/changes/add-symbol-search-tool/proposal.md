# add-symbol-search-tool: Proposal

## Why

The agent can probe one `lib_id` at a time (`verify_symbols`) but cannot ask which library a part actually lives in. KiCad's nicknames rarely follow from the part number: `TPS61165DBV` is in `Driver_LED`, `AudioJack3` in `Connector_Audio`, `INA226` in `Sensor_Energy`. A single-library probe that misses therefore proves nothing about availability, yet reads to the agent exactly like a missing part.

Recorded on a real run (`lemondrop`, run-logs/2026-08-07T17-52-03, on a machine with the full stock symbol set installed): stage 4 concluded the machine had a "reduced symbol library", refused, and the recovery supervisor aborted the run on that premise. Every part it declared absent was installed under a nickname it never guessed. The failure was unrecoverable because it happened in stage 4, after stage 3 had already committed the BOM: by then a part with no usable symbol costs a whole redesign, when at part-selection time it costs one substitution.

## What Changes

- **New agent tool `search_symbols`**: takes a part or symbol name, searches every installed `.kicad_sym` library, and returns matching `Lib:Name` lib_ids ranked with exact (separator-insensitive) matches first. Read-only, no unlock required, available in the same phase as `verify_symbols`.
- **Ranking is global, not per library**: candidates from all libraries are ranked together before the result cap applies, so a strong match in a late-scanned library is never displaced by weak matches from earlier ones. This is the whole point of the tool, since a caller reaching for it has already guessed the nickname wrong.
- **Stage 3 of `create` requires availability probing before the BOM commits**: the part-selection prompt directs the agent to run `search_symbols` for every active part (IC, module, connector) and to substitute any part with no installed symbol, moving the discovery from stage 4 (unrecoverable) to stage 3 (a cheap swap).
- **Symbol availability claims are fact-checked before the recovery supervisor rules on them**: every lib_id named in a failed stage's failure text and transcript excerpt is deterministically re-probed, and the results are injected into the diagnosis prompt as ground truth that overrides the transcript's prose. Coverage is stated explicitly: the probe is capped, and lib_ids beyond the cap are named as unprobed rather than silently omitted, so "not checked" is never read as "absent".

## Capabilities

### Modified Capabilities

- `agent-core`: the tool list gains `search_symbols`; the recovery/diagnosis turn gains a deterministic machine-verified symbol-facts block with explicit coverage reporting.
- `create-pipeline`: stage 3 (part selection) gains the installed-symbol availability requirement as part of its prompt contract.

## Impact

- **Code**: `src/kicad/symlib.ts` (`searchInstalledSymbols`, `listInstalledLibraries`, shared `rankSymbolNames` ranking used by both resolvers); `src/agent/tools.ts` (the `search_symbols` schema and handler); `src/agent/recovery.ts` (`symbolAvailabilityFacts`, the diagnosis prompt); `src/commands/create.ts` (stage 3 prompt, diagnosis call site).
- **Tests**: `test/symlib.test.ts` covers cross-library discovery, global rank ordering under a small cap, separator-bearing library nicknames, and the probe-coverage disclosure.
- **Unchanged contracts**: the tool is read-only and network-free, so `check`/`verify` stay LLM-free and network-free (AC-2.1); spec-gating of the edit tools is unaffected; no config, no new dependency.
- **Not in scope**: deterministic enforcement of per-refdes symbol availability at stage-3 completion. Matching a BOM row to a lib_id requires fuzzy MPN-to-symbol resolution (`STM32F103C8T6` to `MCU_ST_STM32F1:STM32F103C8Tx`), and a gate built on it would refuse valid BOMs. Stage 3's requirement stays at prompt strength until that resolution is reliable.

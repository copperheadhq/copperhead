# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Stage 3 checks symbol availability before the BOM commits

Stage 3 (part selection) SHALL direct the agent to establish, before committing an active part to `docs/BOM.md`, that the part is drawable with the KiCad symbol libraries installed on this machine: run `search_symbols` for every IC, module, connector and other active part, and substitute any part with no installed symbol.

The requirement exists because stage 4 draws only from installed symbols, so a BOM row whose symbol cannot be resolved makes the run unwinnable at a point where the BOM is already fixed. Discovering the gap during part selection costs one substitution; discovering it during schematic capture costs a redesign. This requirement adds to, and does not relax, stage 3's existing per-refdes contract: one row per refdes, no grouped rows, values in the Value column, prose in Rationale.

The requirement is carried by stage 3's prompt, not by its completion gate. Deterministically matching a BOM row to a lib_id needs fuzzy MPN-to-symbol resolution (`STM32F103C8T6` to `MCU_ST_STM32F1:STM32F103C8Tx`), and a completion gate built on today's matching would refuse valid BOMs — a worse failure than the one it prevents. Stage 3's completion contract is therefore unchanged.

#### Scenario: Part with no installed symbol is swapped at selection time

- **WHEN** stage 3 considers an active part and `search_symbols` returns no installed symbol for it
- **THEN** the part is replaced with one whose symbol is installed, before the BOM row is written

#### Scenario: Availability failure does not block a valid BOM

- **WHEN** stage 3 writes a BOM whose parts are real but whose MPNs do not match any symbol name literally
- **THEN** stage 3 still completes on its existing contract, and no availability check refuses the stage

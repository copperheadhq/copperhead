## Why

The drafter puts every design on one flat sheet: each group becomes a coloured box, and every connection between groups becomes a global label. That reads well at A4 but not at A1. The public render of KiCad's cm5_minima demo (84 parts, 499 wires and 190 labels on one A1 sheet) drew a fair complaint that nobody could debug it on a bench. Real projects at that size are hierarchical: SPEC.md already describes the project schematic as "possibly hierarchical, multiple sheets", and the checker and scorer already walk sub-sheets. Only the drafter cannot produce them.

## What Changes

- The drafter can emit a **hierarchical schematic**:
  - Each intent group becomes its own sub-sheet file.
  - The root sheet holds one sheet symbol per group.
  - A signal net that spans groups becomes a `hierarchical_label` in each sub-sheet it touches, plus a matching sheet pin on that sheet's symbol.
  - The root sheet joins the pins with wires, or with a stub and a local label when a wire would not read well.
  - Power and ground nets stay on power symbols, which KiCad treats as global.
- **New intent hint** `hints.sheets`, taking `flat`, `hierarchical` or `auto` (the default):
  - `auto` goes hierarchical when the intent has two or more groups and the flat draft would need paper larger than A3. Otherwise it stays flat.
  - Every existing golden and reference board is A5 or A4, so all of them stay byte-identical.
- Inside a sub-sheet, a net used only on that sheet gets a local label rather than a global one. A net that also reaches another sheet carries hierarchical labels even where its in-sheet part is fully wired.
- The draft report, `copperhead draft schematic`, the `draft_schematic` tool and the create stage-4 staleness probe all handle multiple files:
  - The report lists every sheet written.
  - Sub-sheet files left over from a previous hierarchical draft are removed, but only files the drafter itself wrote.
- Drafted sub-sheets get the same protection as the root sheet: geometry edits to them are refused.
- This supersedes, for hierarchical mode only, the earlier decision that all connectivity between groups goes through net labels on one sheet (design D2 in `archive/2026-08-26-deterministic-schematic-drafting`).

## Capabilities

### New Capabilities
- `schematic-hierarchy`: covers how the drafter chooses between flat and hierarchical output, how it splits groups into sub-sheets, and how it connects them (hierarchical labels, sheet pins, root wiring). It also covers emitting multiple files with deterministic identifiers and instance paths, the multi-file report, cleanup and edit guard, and the netlist-equivalence and ERC guarantees.

### Modified Capabilities
<!-- The drafting capabilities (schematic-drafting-engine, schematic-emission, …) were never synced into openspec/specs/ (only SPEC.md lives there). The new behaviour therefore lives in the new capability above, and SPEC.md gains matching AC-16.65+ entries. -->

## Impact

- **Code:**
  - `src/kicad/draft/engine.ts`: per-group drafting with external-net marking, and root layout.
  - `src/kicad/emit.ts`: sheet symbols, sheet pins, hierarchical labels, multi-level instance paths.
  - `src/kicad/draft/draft.ts`: mode selection, multi-file result, write and cleanup.
  - `src/kicad/draft/ir.ts`: validation of the `hints.sheets` hint.
  - `src/cli.ts` and `src/capabilities/handlers.ts`: reporting, and the drafted-sheet edit guard.
  - `src/commands/create.ts`: staleness probe and the stage-4 prompt's schema prose.
- **Tests:**
  - New fixtures that force hierarchical output, with a golden and a netlist round trip through `kicad-cli` when it is available.
  - The real-designs script and corpus test must follow sub-sheets. Their netlist comparison already does, through `kicad-cli`.
  - The flat goldens are unchanged.
- **Artifacts:** the `manual-tests/real-designs/examples/*` snapshots at A2 and larger will be regenerated as hierarchical, rendered one PNG per sheet.
- **Docs:** SPEC.md §AC-16 gains new criteria (AC-16.65 onward).
- **Dependencies:** none new.

## 1. Intent and mode selection

- [ ] 1.1 Add `hints.sheets?: 'flat' | 'hierarchical' | 'auto'` to `SchematicIntent` (`src/kicad/draft/ir.ts`). Validate its value, and report group slug collisions as findings.
- [ ] 1.2 Add a `groupSlug` helper: lowercase, with every run of `[^a-z0-9]` replaced by `-` and trimmed. Add a `subSheetFile(rootBasename, group)` helper.
- [ ] 1.3 In `draft.ts`, implement mode selection (H1). `flat` does what happens today. `auto` drafts flat and switches when there are two or more groups and the paper is larger than A3. `hierarchical` falls back to flat, with a note, when there are fewer than two groups.

## 2. Engine: sub-sheet drafting

- [ ] 2.1 Build the sub-intent split (H2): each group's parts, nets restricted to that group's endpoints, no-connects, and the hints minus `sheets`. Compute `externalNets` for each group.
- [ ] 2.2 Add three `draftSchematicPlacement` options: `externalNets`, `labelScope: 'local'` and `sheetLabel`. Leave the flat path unchanged when they are absent.
- [ ] 2.3 For external nets, force hierarchical labels on every endpoint and wired run (H3), reusing the global-conversion path. With `labelScope: 'local'`, intra-sheet unwired stubs get local labels.
- [ ] 2.4 Unit-test a single-endpoint external net: it gets one stub and one hierarchical label, and nothing is merged.

## 3. Root sheet layout

- [ ] 3.1 Create `src/kicad/draft/root.ts`. Size sheet symbols, place them in a grid by group order, and pick the paper (H4).
- [ ] 3.2 Assign pin sides and order the pins on each side. Take each pin's shape from the sub-sheet's label shape.
- [ ] 3.3 Wire facing two-sheet nets across adjacent-column channels using reserved tracks. Give every other pin a stub and a local label.
- [ ] 3.4 Run the merged-net and grid checks over the root geometry, and refuse the draft on failure.

## 4. Emission

- [ ] 4.1 Extend `PlacementModel` and `emitSchematic` (H5):
  - sheet blocks with pins and instances;
  - `hierarchical_label`;
  - `instancePrefix` for symbol instance paths;
  - `sheet_instances` on the root only;
  - sheet-scoped UUID paths.
- [ ] 4.2 Confirm the flat output is byte-identical by running the goldens (Tier C and the reference boards) unchanged.

## 5. Surfaces

- [ ] 5.1 Return `files[]` from `draftSchematicToText`. `draftSchematic` writes every file and removes stale drafted sub-sheets, guarded by the previous root's `Sheetfile` and the generator mark (H6).
- [ ] 5.2 Add the mode, the reason for it, and each sheet with its file, group and paper to the draft report and its formatter.
- [ ] 5.3 Update the create stage-4 staleness probe to compare every drafted file. Update the stage-4 prompt's intent-schema prose to document `hints.sheets`.
- [ ] 5.4 Confirm the `edit_file` guard refuses drafted sub-sheets, and add a test.

## 6. Verification

- [ ] 6.1 Build a fixture of three groups with shared signals and power, forced to `hierarchical`. Test the label and pin pairing, that no global labels appear, determinism, and a golden file set.
- [ ] 6.2 Add a `kicad-cli`-gated test: round-trip the fixture's netlist and check that its partition equals the intent. Also check ERC for hierarchy mismatches.
- [ ] 6.3 Make `scripts/draft-real-designs.ts` write all sheets, render one PNG per sheet, and list them in `REPORT.md`. Regenerate the examples at A2 and larger, and confirm the netlist diff shows 0 pin groups lost and 0 gained.
- [ ] 6.4 Run the full offline test suite and `npm run build`.

## 7. Docs

- [x] 7.1 Add AC-16.65 through AC-16.71 to SPEC.md §AC-16 so they mirror this change's scenarios.

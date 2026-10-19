# add-hierarchical-drafting: Design

## Context

The drafter (`src/kicad/draft/`) turns `schematic.intent.json` into one `.kicad_sch`. The steps are:
1. `draftSchematicToText` (`draft.ts`) validates the intent.
2. `draftSchematicPlacement` (`engine.ts`) runs up to 16 rounds of `draftOnce`.
3. `emitSchematic` (`emit.ts`) writes the chosen draft as canonical text.

On that single sheet, groups are captioned boxes. Signal clusters form only inside a group. Any stub left unwired ends in a `global_label`. Power nets become per-pin power symbols. The emitter hardcodes one level of hierarchy: every symbol instance path is `/<rootUuid>`, and `sheet_instances` holds only page 1.

The read side is already hierarchy-aware:
- `readSheetGeometry` walks `(sheet …)` blocks.
- The legibility checker and scorer evaluate every sheet and attribute findings to it.
- `kicad-cli sch export netlist` flattens the hierarchy for the real-designs round trip.
- The `edit_file` guard recognises drafted files by the generator mark in their header.

The KiCad file shapes this change must produce were taken from KiCad's own `cm5_minima` and `complex_hierarchy` demos:
- A root `(sheet …)` block has `at` and `size`, a `uuid`, `Sheetname` and `Sheetfile` properties, `(pin "NAME" <shape> (at x y angle) (uuid …))` entries, and `(instances (project P (path "/<rootUuid>" (page "N"))))`.
- A sub-sheet file has no `sheet_instances`.
- Symbols inside a sub-sheet carry the instance path `/<rootUuid>/<sheetSymbolUuid>`.

## Goals / Non-Goals

**Goals:**
- A root sheet of sheet symbols plus one sub-sheet per group, joined by hierarchical labels and sheet pins. The result must be netlist-identical to the intent, deterministic, and pass ERC.
- Reuse the existing per-sheet engine unchanged in spirit. A sub-sheet is a flat draft of one group.
- Flat output stays byte-identical wherever `auto` keeps a design flat (every current golden and reference board).

**Non-Goals:**
- Buses and bus entries. A group of `HDMI_*` nets is drawn as separate pins. Bus aliasing can come later.
- Nested hierarchy (sub-sheets inside sub-sheets). There is exactly one level.
- Reusing one sub-sheet file for repeated instances (the multichannel pattern). Each group is its own file and its own instance.
- Round-tripping an existing hand-drawn hierarchy. The intent's groups define the hierarchy.

## Decisions

### H1. `auto` selects the mode from a real flat draft

`auto` first runs the flat draft that happens today. If there are two or more groups and `fit.paper` is larger than A3, it discards that draft and drafts hierarchically. Otherwise it emits the flat draft as is, which is what keeps every flat golden byte-identical.

The cost is one wasted flat draft on large designs. An estimate from part counts was rejected: it would disagree with the drafter's real packing near the threshold. It would also make the mode depend on a second, independent sizing model.

`hierarchical` with fewer than two groups falls back to `flat` and adds a report note.

### H2. A sub-sheet is a flat draft of a sub-intent

For each group, the drafter builds a sub-intent from the already-validated intent:
- That group's parts.
- Every net restricted to endpoints in that group.
- No-connects on those parts.
- The same hints, apart from `sheets`.

It then calls `draftSchematicPlacement` with three new options:
- `externalNets`: the set of signal nets that also have endpoints in another group.
- `labelScope: 'local'`: intra-sheet unwired stubs end in a local `label` instead of a `global_label`. Net names are unique across the intent, so a local label can never split or merge a net.
- `sheetLabel`: the title-block text.

The intent is validated once, before the split. The sub-intents skip `validateIntent`, which would reject single-endpoint nets and group headings. After the split, a net can have a single endpoint on a sheet. For example, one MCU pin going out to the connector sheet is a one-stub net that ends in a hierarchical label. The engine's unwired-stub path already handles one stub. A unit test pins that case.

### H3. External nets always leave through hierarchical labels

The flat engine already has a rule for a net with both a wired run and leftover stubs: every label of that net becomes a global flag, because a local label and a global label with the same name do not connect (`engine.ts` around 4137). For a net in `externalNets`, that rule applies unconditionally, with `hierarchical_label` as the flag kind:
- A fully wired run still gets a label, on its anchor.
- Every label of the net on that sheet is hierarchical.

The label shape comes from `flagShape` over the net's pins on that sheet, the same rule used today. The sheet pin on the root takes the same shape.

### H4. Root layout is its own small, deterministic pass

The root sheet is not a job for `draftOnce`: it has no library symbols, stubs or power nets. A new module, `src/kicad/draft/root.ts`, runs these steps:
1. **Sheet symbol size.** Height is `max(pins on left, pins on right) × 2.54 + margins`. Width comes from the longest pin name on each side plus the `Sheetname`, rounded up to the grid.
2. **Placement.** Sheet symbols go in group order into a grid of `ceil(sqrt(N))` columns, with channels between columns wide enough for labels. Paper is the smallest in `PAPERS` that fits, using the same frame and title-block constants as flat drafting.
3. **Pin sides.** For each sheet, a net's pin goes on the side facing the centroid of the net's other sheets. Ties go to the right. Pins on a side are ordered by the partner's row, then the partner's pin order, then net name, which keeps crossings down.
4. **Connections.** A two-sheet net whose pins face each other across one channel, with the two sheets in adjacent columns, is wired straight or with one jog in that channel. Each channel keeps its own reserved vertical tracks so wires never share a track. Every other pin, including nets touching three or more sheets and routes that would cross a symbol or another net, gets a 2.54 mm stub ending in a local label of the net name.

The existing merged-net check (`report.mergedNets`) runs over the root geometry too. A root that fails it is refused, as a flat sheet would be.

### H5. The emitter learns sheets and instance prefixes

`PlacementModel` gains the following:
- `sheets?: EmitSheet[]`: each has name, file, at, size, page and pins `{ name, shape, at, side }`.
- `instancePrefix?: string`: `/<rootUuid>` by default, and `/<rootUuid>/<sheetUuid>` for a sub-sheet.
- `isRoot: boolean`: controls `sheet_instances`.
- `'hierarchical'` as a label kind.

UUIDs stay UUIDv5, but each sub-sheet's semantic paths are prefixed with `sheet/<slug>/` so identical local structure on two sheets never collides. The root UUID stays derived from the project name, so the flat output is unchanged. Sheet pin angles and justification follow the demo files: angle 0 with `justify right` on the right edge, 180 with `justify left` on the left edge. The round-trip test in H7 is the check that these are right.

### H6. Multi-file result, write and cleanup

`draftSchematicToText` returns `files: { path, text }[]` with the root first. `text` stays as the root's text, so existing callers still compile. `draftSchematic` writes all files and then removes stale sub-sheets. A sub-sheet is stale when both of these hold:
- The **previous** root on disk referenced it through `Sheetfile`.
- It is not in the new set, and its header carries the `copperhead-draft` generator.

Nothing else is ever deleted. The create stage-4 staleness probe compares every file in `files` against disk. The edit guard needs no change, because sub-sheets carry the generator mark.

File names are `<root-basename>-<slug>.kicad_sch`. A slug collision is reported during validation (in `ir.ts`, when `hints.sheets` is not `flat`, or in `auto` once hierarchical mode is chosen), before anything is written.

### H7. Verification reuses the netlist round trip

- **Offline unit tests:** a fixture of three groups with shared signals, forced to `hierarchical`. They check:
  - one hierarchical label and one sheet pin per sheet per external net;
  - no global labels;
  - determinism across two runs;
  - a golden set of files.
- **`kicad-cli`-gated test:** exports the root's netlist and compares `netPartition` with the intent. It also runs ERC with no hierarchical-label, sheet-pin, or multiple-net-name violations.
- **Real designs:** `scripts/draft-real-designs.ts` already compares partitions through `kicad-cli`, which flattens. It now also renders one PNG per sheet (`kicad-cli sch export svg` emits one SVG per sheet).

## Risks / Trade-offs

- **A local label changes label geometry on sub-sheets.** Text slots and reach estimates were tuned on global flags. Mitigation: local labels are shorter than flags, so reach only shrinks. The legibility gates still run on every sheet, and sub-sheets are not goldens yet.
- **The root can become a label forest on dense designs** such as cm5_minima, where the CM5 sheet touches everything. That is acceptable, and it is what hand-drawn hierarchical roots of that design do too (the original uses bus pins). Buses are the follow-up. The report states the wired and labelled counts on the root so the effect is visible.
- **Double drafting in `auto`** costs one flat draft on large designs. This is bounded by the existing 16-round limit, and it only happens past A3.
- **Sheet pin format drift across KiCad versions.** The emitter pins version `20231120`. The kicad-cli-gated round trip catches any mismatch in how KiCad loads it.
- **The group-box requirement on sub-sheets.** Each sub-sheet keeps its one captioned box, so the checker's `ungrouped-symbol` and caption rules hold unchanged. A future change can let sub-sheets drop the box and exempt them in the checker.

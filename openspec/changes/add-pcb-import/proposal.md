# add-pcb-import: Proposal

This change implements the import adapter of copperhead RFC 11 version 1.4,
Section 5.1: an adapter that does not yet pass through the kernel MAY compile
the layout input directly, using the same schema and the identity rules of RFC
3 Section 4.2, naming the hashes of the files it imported. It builds on
`add-pcb-ir` ([#495](https://github.com/copperheadhq/copperhead/pull/495)).

## Why

`copperhead pcb diff` compared layout records, so a person had to have JSON to
see what a change did to a board. With an import, the diff works on what
people actually have: the board file, and the same file at an earlier git
revision.

## What Changes

- **[import-kicad.ts](../../../src/pcb-ir/import-kicad.ts)** compiles a
  `.kicad_pcb` into a layout input:
  - **Identifiers** are RFC 3 UUIDv5 derivations, from each part's schematic
    symbol path, or its KiCad identifier for a part placed only on the board,
    so a renumbered part keeps its identifier. Routing is known by its KiCad
    identifier, or else by its content, never by its place in the file.
  - **Footprints:** definitions are read from the board's embedded footprints
    and keyed by hash. Each pad's angle is taken relative to its footprint.
  - **Board:** copper layers top to bottom, and nets.
  - **Routing:** traces, arcs and vias, and zones with their definitions
    verbatim.
  - **Outline:** the board outline and cutouts, chained from Edge.Cuts, with
    arcs within the arc tolerance. Each ring runs counter-clockwise from its
    least point, whatever order the file drew its edges in.
  - **Ownership:** every placement is owned by `import`, so RFC 12's default
    policy protects it.
  - **What it cannot represent** is listed in the board's `lossy` field,
    never approximated silently:
    - back-side footprint definitions, which are not normalized to the front
      view
    - the copper of non-rectangular pads, imported as its bounding rectangle
    - courtyards drawn as lines
    - rule areas
    - traces and vias on no net, which RFC 11's records cannot hold
    - the fabrication profile
- **`copperhead pcb diff`** takes `.kicad_pcb` files and `<rev>:<path>` boards
  on either side. `--project` names the project identifiers derive under; the
  default is the first board's file name, for both sides. What an import could
  not represent is printed on standard error.

## Not in This Change

- **Normalizing back-side footprints** to the front view. KiCad's flip
  convention needs a check against real boards first.
- **Rule areas as regions.**
- **Write-back of operations** to the board file (RFC 11 Section 6.12).

## Capabilities

### New Capabilities

- `pcb-ir`: the KiCad import.

### Modified Capabilities

- `cli-surface`: `pcb diff` takes boards and git revisions.

## Impact

New `src/pcb-ir/import-kicad.ts` and `test/pcb-import.test.ts`. `pcb diff` gains
board sides and `--project`. The board fixture gains schematic symbol paths.
SPEC.md has AC-21.

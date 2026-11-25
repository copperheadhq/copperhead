# Tasks: add-pcb-ir

Implements copperhead RFC 11 version 1.4, Sections 6, 6.11, 6.13, 14.1 and 14.4,
and RFC 3 version 1.6, Section 17.1
([copperhead-rfcs#15](https://github.com/copperheadhq/copperhead-rfcs/pull/15)).

## 1. Records and types

- [x] 1.1 Vendor the RFC 11 schemas from copperhead-rfcs#15 at `c712696`
      into `src/pcb-ir/schemas/rfc11/`.
- [x] 1.2 `scripts/gen-pcb-ir-types.ts` generates
      `src/pcb-ir/types.generated.ts`, resolving each `$id` to its vendored
      file, with no network.
- [x] 1.3 Test that the generated types are current and that every RFC
      example validates.

## 2. Canonical form

- [x] 2.1 `canonical`, `canonicalBytes` and `contentHash`, following RFC 3
      Section 17.1.
- [x] 2.2 Test that every hash the RFC examples cite reproduces, and each
      rule of the canonical form.

## 3. Placement diff and views

- [x] 3.1 `placementDiff`:
      - against a candidate, with blocks composed by their transform
      - against a later layout input
      - owners, approval classes, and constraint changes
- [x] 3.2 `renderDiffText`: the text view, matching RFC 11 Section 14.4's
      example exactly.
- [x] 3.3 `boardText`:
      - the board text of a `.kicad_pcb`
      - one line per fact, independent of file order
      - KiCad 7 and 8 spellings of reference and lock
- [x] 3.4 `copperhead pcb diff` and `copperhead pcb textconv`, read-only and
      LLM-free.
- [x] 3.5 Check by hand that git shows a moved footprint as one changed line,
      through the textconv driver.

## 4. Next

- [ ] 4.1 Import a KiCad board into a layout input (RFC 11 Section 5.1), so
      that `pcb diff` takes board files and git revisions.
- [ ] 4.2 The SVG overlay image of Section 14.4 (`pcb diff --render`).
- [ ] 4.3 Move `feat/pcb-layout-framework` onto `pcb-ir`, replacing
      `PcbDesign`.
- [ ] 4.4 When copperhead-rfcs#15 merges, vendor the schemas and examples
      again if they changed, and archive this change.

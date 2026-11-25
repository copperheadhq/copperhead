# add-pcb-ir: Proposal

This change implements copperhead RFC 11, *The Copperhead PCB Layout Generation
Standard*, version 1.4: the `pcb-ir` unit of Section 14.1, the layout records of
Section 6 with the schemas of Section 6.13, the placement diff of Section 6.11,
and two of the change views of Section 14.4. It follows RFC 3 version 1.6,
Section 17.1, for canonical form and content hashes. Both revisions are open as
[copperhead-rfcs#15](https://github.com/copperheadhq/copperhead-rfcs/pull/15).
The change may proceed while that PR is open, and claims conformance only to
the version that merges.

## Why

RFC 11 1.4 makes the layout records schema-first: the JSON Schemas published in
the RFC repository define every record, and implementations derive their types
from them. The records cite one another by content hash. So copperhead's
encoder must write the same bytes as the kernel's, which is fang's Python
serializer ([fang#22](https://github.com/copperheadhq/fang/pull/22)). Every
later layout feature reads and writes these records: import, placement,
routing, and write-back. They need one typed, hash-exact foundation, not a
private copy of the shapes.

A reviewer also needs to see what a layout change does to a board. RFC 11
defines that as a placement diff and three views of it. Two of the views are
useful before any placement engine exists.

## What Changes

- **`src/pcb-ir/`, a new unit with no runtime dependencies:**
  - **`schemas/rfc11/`:** the RFC 11 schemas, vendored unchanged from
    copperhead-rfcs#15 at `c712696`.
  - **`types.generated.ts`:** TypeScript types generated from those schemas by
    `scripts/gen-pcb-ir-types.ts`. A test fails when they drift from the
    schemas.
  - **`canonical.ts`:** canonical JSON and `contentHash`. It reproduces every
    hash the RFC's example records cite. The rules it follows:
    - keys sorted by code point
    - entities sorted by id, and other items by serialization
    - numbers written positionally
    - exactly the order-keeping keys the standards declare
  - **`geometry.ts`:**
    - pose composition in integer nanometres
    - quarter turns exact, millidegrees rounded once
    - exact formatting in millimetres and degrees
  - **`diff.ts`:** the placement diff of a layout input against a candidate,
    resolving block members through their block layouts, or against a later
    layout input. Each row carries its owner and its approval class under
    RFC 12's default policy.
  - **`textview.ts`:** the text view of Section 14.4.
  - **`textconv.ts`:** the board text of Section 14.4, read from a
    `.kicad_pcb` with the existing read-only s-expression parser.
- **CLI:**
  - `copperhead pcb diff <before> <after> [--blocks <dir>] [--json]`
  - `copperhead pcb textconv <board>`, used as git's diff driver through
    `.gitattributes`
  - Neither calls a model, the network, or KiCad, and neither writes anything.
- **Dev dependencies:**
  - `json-schema-to-typescript`, used only for generating the types
  - `ajv`, used only for validating the examples in tests

## Not in This Change

- **Importing a board into a layout input** (Section 5.1), so `pcb diff` takes
  layout input and candidate JSON for now. It says so when given a
  `.kicad_pcb`.
- **The SVG overlay image** of Section 14.4.
- **Any placement engine.**
- **The unmerged `feat/pcb-layout-framework` `PcbDesign` types.** This change
  supersedes them; that branch migrates onto `pcb-ir` rather than keeping a
  second set of shapes.

## Capabilities

### New Capabilities

- `pcb-ir`: the layout records and their types, canonical form, placement
  diff, text view, and board text.

### Modified Capabilities

- `cli-surface`: the CLI gains `pcb diff` and `pcb textconv`.

## Impact

- **New code:** `src/pcb-ir/`, `src/commands/pcb.ts`,
  `scripts/gen-pcb-ir-types.ts`, and two `pcb` subcommands in `src/cli.ts`.
- **New tests:** `test/pcb-ir.test.ts`, with fixtures in
  `test/fixtures/rfc11/` (the RFC examples) and `test/fixtures/pcb-ir/` (a
  small KiCad 8 board).
- **Conformance:**
  - The diff computed from the RFC's examples equals the placement diff the RFC
    publishes, byte for byte.
  - Its text view matches the example in RFC 11 Section 14.4 exactly.
- **Suite:** 1407 tests pass, 21 skipped.

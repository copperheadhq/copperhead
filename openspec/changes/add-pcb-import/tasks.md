# Tasks: add-pcb-import

Implements copperhead RFC 11 version 1.4, Section 5.1, with the identity
rules of RFC 3 version 1.6, Section 4.2.

## 1. Import

- [x] 1.1 UUIDv5 identifiers as RFC 3 derives them, checked against the RFC
      example and against a published UUIDv5 value.
- [x] 1.2 Footprint definitions from the board's embedded footprints:
      - pads, with their angles taken relative to the footprint
      - drills and copper
      - courtyards
- [x] 1.3 Components, owned by the import adapter, with pads mapped to their
      nets and pins; nets.
- [x] 1.4 Routing:
      - traces and arcs
      - vias
      - zones, with their definitions kept verbatim
- [x] 1.5 The board outline and cutouts, chained from Edge.Cuts.
- [x] 1.6 What the import cannot represent goes in `lossy`.

## 2. Command

- [x] 2.1 `pcb diff` takes `.kicad_pcb` files and `<rev>:<path>` boards, with
      `--project`.

## 3. Tests and spec

- [x] 3.1 `test/pcb-import.test.ts`:
      - the import validates against the schema
      - footprint keys are content hashes
      - identifiers are derived as RFC 3 specifies
      - renumbering keeps identity
      - file order does not matter
      - two boards diff, and so does a board against its git revision
- [x] 3.2 SPEC.md: the `pcb diff` surface, and AC-21; the CLI reference.
- [x] 3.3 Review fixes, each with a test that fails without it:
      - two boards under different names share one project
      - a part placed only on the board is known by its KiCad identifier
      - routing is known by `uuid`, then `tstamp`, then its content
      - outline rings are normalized
      - copper on no net is listed in `lossy`
      - `pcb diff` prints the `lossy` notes on standard error

## 4. Next

- [ ] 4.1 Normalize back-side footprints to the front view, once checked
      against boards KiCad flipped.
- [ ] 4.2 Import rule areas as regions.

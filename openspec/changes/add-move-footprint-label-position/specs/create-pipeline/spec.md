# create-pipeline — Delta Spec

## MODIFIED Requirements

### Requirement: Footprints move with their pads

Layout SHALL place parts with a `move_footprint` tool (refdes, x, y, optional absolute rotation), gated on a validated proposal like `edit_file`, which rewrites the footprint's placement, adds the rotation change to every pad, property, and text angle, since KiCad stores those as absolute, and moves and turns its zones, which KiCad stores in board coordinates. The tool SHALL also accept an optional `label_x`/`label_y` pair naming board coordinates at which to place the part's Reference label: the stored offset SHALL be the footprint-local inverse of that point under the footprint's new origin and rotation, so KiCad renders the field at exactly the requested point at 0°, 90°, 180°, and 270°. The pair SHALL be given together or not at all (one alone SHALL be an error, never paired with the label's current other coordinate), and the footprint SHALL carry a Reference property (KiCad 7+/8+ `property` or KiCad 5 `fp_text reference`) that already holds an `(at …)`, or the tool SHALL fail with the reason. The layout-draft prompt SHALL forbid hand-editing a footprint's placement or its Reference label, directing silkscreen label fixes through `label_x`/`label_y`. A DRC finding inside a footprint that KiCad reports as not matching its library SHALL NOT be excused as library-intrinsic.

#### Scenario: Rotated part still matches its library

- **WHEN** U1 is rotated 90 degrees with `move_footprint`
- **THEN** DRC reports no `lib_footprint_mismatch` and no finding inside U1

#### Scenario: A hand rotation is caught

- **WHEN** only the footprint's own angle is edited
- **THEN** DRC reports `lib_footprint_mismatch`, the findings inside the part fail, and the stage cannot finish

#### Scenario: A label placed at a board point at every rotation

- **WHEN** `move_footprint` places a part's Reference label at a board coordinate, at rotation 0°, 90°, 180°, and 270°
- **THEN** DRC reports the reference field at exactly that coordinate each time, and no other footprint's byte changes

#### Scenario: One call moves the part and places its label

- **WHEN** a single `move_footprint` call sets a new origin and rotation and a `label_x`/`label_y`
- **THEN** the label's stored offset is measured from the new origin under the new rotation

#### Scenario: A lone label coordinate is refused

- **WHEN** only `label_x` (or only `label_y`) is given
- **THEN** the tool returns an error naming the pair, and the board is not written

#### Scenario: A footprint with no Reference label

- **WHEN** `label_x`/`label_y` are given for a footprint with no Reference property, or one whose Reference has no `(at …)`
- **THEN** the tool fails with the reason and leaves the board unchanged

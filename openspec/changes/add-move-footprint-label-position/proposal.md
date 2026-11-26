# add-move-footprint-label-position: Proposal

## Why

The layout-draft stage's silkscreen fixes are still hand work (#380). `move_footprint` can move and rotate a part, but it cannot place the part's Reference label, so the only way to move a label off a pad or off the board edge is `edit_file` on the raw `.kicad_pcb`. KiCad stores a footprint child's position in the footprint's own **unrotated** frame and renders it at `origin + rotate(local, rotation)`, so the model has to invert that rotation in its head, per part, per angle. It gets it wrong: the reported run left `Reference field of R2 @ (106, 116.57)` clipping J1's pads, and the model's fix moved the wrong coordinate. The label placement is pure geometry that copperhead can compute exactly.

## What Changes

- **`move_footprint` gains optional `label_x`/`label_y`**: board coordinates at which to place the part's Reference label. The handler converts the point into the footprint's local frame by inverting the point against the footprint's NEW origin and rotation, then splices the label's `(at …)`.
- **Both or neither**: giving exactly one of `label_x`/`label_y` is an error, never a silent pairing with the label's current other coordinate.
- **A Reference is required**: the footprint must already carry a Reference property (KiCad 7+/8+ `property` or KiCad 5 `fp_text reference`) with an `(at …)`; otherwise the tool fails with the reason instead of guessing.
- **One call can move and label**: the label is placed against the origin and rotation the same call sets, so a part can be moved and its label fixed in a single turn.
- **The layout-draft prompt directs silk fixes to the tool**: stage 5 tells the agent to use `label_x`/`label_y` for a Reference label and never to hand-edit the label's `(at …)`; `edit_file` still covers tracks, vias, zones, the outline, and the Value property.

## Scope

`move_footprint` already exists and is spec-gated; this change extends it and its prompt, not the tool registry, the gate, or the Gate-3 verification flow.

## Capabilities

### Modified Capabilities

- `create-pipeline`: the `move_footprint` requirement (AC-15.42) gains the Reference-label placement contract and its failure modes; the layout-draft prompt sends silkscreen label fixes through the tool.

## Impact

- **Code**: `src/kicad/populate.ts` (`moveFootprint` gains an optional label position and the inverse-rotation transform; `LabelPosition`), `src/capabilities/handlers.ts` (`move_footprint` schema and validation, success message), `src/commands/create.ts` (stage-5 prompt).
- **Tests**: `test/board-populate.test.ts` — text-level assertions for the transform at 0°/90°/180°/270°, move-and-label in one call, the legacy `fp_text` path, and the missing-Reference failure; handler tests for the paired-ness and numeric checks; a real-`kicad-cli` DRC test that places the label over another part's pad and asserts KiCad reports `Reference field of U1` at exactly the requested board point at each rotation.
- **Invariants**: the board edit stays an anchored text splice (no parse tree is serialized); the tool is unchanged as a Gate-3 mutation, so the ERC/DRC and snapshot behaviour still applies; `check`/`verify` stay LLM-free.
- **SPEC.md**: AC-15.42.
- **Not in scope**: placing the Value label or any other footprint child, free-text silkscreen, and auto-placing labels without an explicit coordinate.

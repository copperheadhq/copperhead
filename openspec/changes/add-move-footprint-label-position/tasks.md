# add-move-footprint-label-position: Tasks

## 1. Geometry

- [x] 1.1 `src/kicad/populate.ts`: add an exported `LabelPosition { x, y }` and a 6th optional `label` parameter to `moveFootprint`.
- [x] 1.2 Convert the label's board point into the footprint's local frame by inverting it against the footprint's NEW origin and rotation (`rotate(label.x - x, label.y - y, -rotation)`), rounding like every other coordinate.
- [x] 1.3 Locate the Reference child in both KiCad 7+/8+ `(property "Reference" …)` and KiCad 5 `(fp_text reference …)` form; throw a named error when the footprint has no Reference or its Reference has no `(at …)`.
- [x] 1.4 Splice only the Reference's `(at …)` span; leave every other byte, including the Value and the pads, unchanged.

## 2. Tool contract

- [x] 2.1 `src/capabilities/handlers.ts`: add optional `label_x`/`label_y` number properties to the `move_footprint` schema and describe the tool's new use for silkscreen fixes.
- [x] 2.2 Validate that `label_x`/`label_y` are given together and are finite numbers; return the reason (never a silent pairing) otherwise.
- [x] 2.3 Pass the label position to `moveFootprint` and name the placed point in the success message.

## 3. Prompt

- [x] 3.1 `src/commands/create.ts`: the layout-draft stage-5 prompt directs silkscreen fixes to `label_x`/`label_y` on `move_footprint` and forbids hand-editing the Reference `(at …)`; `edit_file` keeps tracks, vias, zones, the outline, and the Value.

## 4. Verification

- [x] 4.1 Text-level tests for the local-frame inverse at 0°, 90°, 180° and 270°, for the footprint's current rotation when a move does not set one, for a move-and-label in one call, for the legacy `fp_text` path, and for the missing-Reference failure.
- [x] 4.2 Handler tests: a lone `label_x` (or `label_y`) is refused and the board is untouched; a non-numeric coordinate is refused.
- [x] 4.3 Real-`kicad-cli` DRC test: place U1's Reference over C1's pad and assert KiCad reports `Reference field of U1` at exactly the requested board point at each rotation.
- [x] 4.4 Update `openspec/specs/SPEC.md` AC-15.42 and run `npm run typecheck` and the offline suite.

## 5. Close-out

- [x] 5.1 Run `npm run typecheck`, `npm test`, and `npm run docs:build`.
- [x] 5.2 Report any live-model test not run; the offline suite does not prove provider parity.

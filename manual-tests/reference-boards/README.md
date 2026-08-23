# Reference boards

Committed reference projects for regression-testing the deterministic drafting engine against known inputs. Unlike the fixture-library goldens in `test/fixtures/golden/` (which use tiny in-repo symbol libraries), a reference board vendors symbols from the real KiCad standard libraries, so it exercises the engine against production symbol geometry while staying fully hermetic: `sym-lib-cache/` is committed, and every re-draft resolves from it, never from the machine's installed libraries.

## The contract

For each board under this directory:

1. `copperhead draft schematic` on a copy of the project MUST reproduce `reference/<name>.kicad_sch` byte for byte. Any difference is an engine regression (or an intentional change, in which case the reference is regenerated and the diff reviewed).
2. The drafted sheet MUST pass ERC with zero violations and the legibility checker with zero error-severity findings.
3. `reference/<name>.png` is the visual reference. After an intentional engine change, re-render and eyeball the new image against the old one before replacing it; the byte diff says WHAT moved, the render says whether it still reads well.

The byte contract is enforced in CI by `test/draft-reference-boards.test.ts`. The visual loop is manual:

```bash
npm run refboards          # re-draft into manual-tests/runs/reference-boards, diff, render
```

The script materializes the board under `manual-tests/runs/reference-boards/` (gitignored, per this directory's convention), drafts it, byte-compares against the reference, and renders a PNG next to it for side-by-side comparison.

## Regenerating a reference

After a deliberate engine change:

```bash
npm run refboards -- --update  # copies the fresh draft and render over reference/
```

Commit the resulting diff and treat the render change as part of review.

## Boards

- `ldo-demo/`: AP1117 LDO with input/output capacitors, power connector, and an LED indicator. Exercises: rail/ground classification from real pin types, PWR_FLAG synthesis on undriven rails only, decoupling-row placement, cross-group net labels, local wire routing, group boxes, content-derived paper.
- `npn-switch/`: ATtiny85 driving an NPN low-side switch with a flyback diode, load header, and polarized bulk capacitor. Exercises: three groups with SUBSYSTEMS.md ordering, no-connect markers on unused MCU pins, letter pin numbers (Q_NPN's B/C/E), top/bottom pin stubs and side text slots, `Device:C_Polarized` decap detection with cross-group owner matching, multi-endpoint label fan-out when a net's span exceeds the wire budget, and content-derived A4 paper.
- `buck-12v-5v/`: TPS54560B step-down converter, 12V to 5V at 4A, with an EN-divider UVLO, RT frequency resistor, type-II compensation network, bootstrap capacitor, Schottky catch diode, power inductor, feedback divider with feedforward capacitor, and a rail LED. The densest control board: 24 parts, 11 nets, 18 endpoints on GND. Exercises: stacked pins (the converter carries GND on both pin 7 and its thermal-pad pin 9, at one symbol coordinate), both `kind` overrides in one intent (`power` on a passive-only output rail that pin types would call a signal, `signal` on the switch node that `power_out` would call a rail), power-symbol value text on downward stubs, label nudging where a later net's trunk would otherwise run through an earlier net's label, and content-derived A3 paper.

## Licensing note

`sym-lib-cache/` contains verbatim symbol definitions vendored from the [KiCad symbol libraries](https://gitlab.com/kicad/libraries/kicad-symbols), licensed CC-BY-SA 4.0 with the KiCad libraries exception permitting use in designs. They are included here solely as design/test inputs, unmodified apart from file packaging.

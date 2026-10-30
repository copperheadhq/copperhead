# rgb-key fixture: provenance

`test/fixtures/rgb-key/` is the `open-key` fixture plus an RGB status LED and six more GPIOs. It exists for the AC-3.3 live test (`add a second RGB LED`), which `open-key` cannot host: its U1 has only four free GPIOs, two of them strapping pins, and an RGB LED needs three channels.

## What is on the sheet

- **U1** `fixture:ESP32-S3-MINI`: the `open-key` symbol with GPIO4 to GPIO9 added on the right side (pins 9 to 14). Pins 1 to 8 are unchanged.
- **R1** 10k EN pull-up and **R2** 1k on `KEY_DAH` (GPIO14), as in `open-key`.
- **D1** `Device:LED_RGBA` (common anode to 3V3, footprint `LED_SMD:LED_RGB_1210`), its cathodes through **R3**, **R4** and **R5** (330) to GPIO4, GPIO5 and GPIO6 (nets `LED_R`, `LED_G`, `LED_B`).
- Free for a second LED: GPIO7, GPIO8, GPIO9, GPIO18 and GPIO21. GPIO0 and GPIO3 stay free too, as strapping pins.

## How it was built

1. `fixture.kicad_sym` (this directory) defines the U1 symbol; `rgb-key.intent.json` is the netlist intent.
2. The draft engine drew the sheet from the intent (`draftSchematic`, with `Device` symbols from KiCad 10.0.7's stock library), embedding every symbol, so the fixture needs no symbol library to load.
3. The engine's output carries `(generator "copperhead-draft")`, which marks a sheet as engine-authored and makes `edit_file` refuse it. AC-3.3, like AC-3.1 and AC-3.2, exercises edits to a hand-drawn sheet, so that one line was changed to `(generator "eeschema")`, which is what KiCad writes when a human takes a drafted sheet over.
4. The `Device:R` and `Device:LED_RGBA` symbols copied from KiCad 10's stock library carry two tokens only KiCad 10's parser accepts, `(in_pos_files yes)` and `(duplicate_pin_numbers_are_jumpers no)`, one of each per symbol. KiCad 9 refuses to load a sheet that contains them, so those four lines were deleted. Nothing else in the sheet was edited, and `rgb-key-fixture.test.ts` fails if either token comes back.
5. The `.kicad_pro`, `.kicad_prl` and `.kicad_pcb` files are `open-key`'s, with only their `filename` entries renamed. That keeps `open-key`'s ERC settings (`footprint_link_issues` and `lib_symbol_issues` ignored), so ERC behaves the same with or without KiCad's symbol library installed.

The sheet stays at file format `20231120`, like `open-key`. Loading was verified with kicad-cli 10.0.7, and with kicad-cli 9.0.8 once the tokens in step 4 were removed (checked in the #436 review); KiCad 8 has not been tried. Re-saving it with `kicad-cli sch upgrade` would stamp the newest format and lock out older KiCad builds.

## Regenerating

Run the draft engine on the intent in a scratch KiCad project whose `sym-lib-table` names `fixture.kicad_sym`, then repeat steps 3 to 5. Re-check that the result passes `copperhead init` and `copperhead check` (ERC clean, drift clean) before replacing the fixture.

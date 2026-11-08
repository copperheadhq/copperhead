# USB-C-powered RP2040 sensor interface

This brief is a synthetic, medium-complexity software acceptance fixture for
Copperhead issue #66. No board will be ordered, assembled, connected to a device,
or represented as physically validated by this task.

Create a two-layer RP2040 board powered only by USB-C 5 V. It should enumerate over
USB and provide a 3.3 V I2C expansion header for a separately attached sensor.
Use ordinary parts with suitable symbols and footprints available to the KiCad
environment. Record the chosen parts and unresolved assumptions.

The board should include:

- A USB-C receptacle with the required sink configuration resistors. No USB PD,
  battery charging, high-voltage input or power sourcing.
- A 3.3 V regulator, decoupling and a power indicator.
- An RP2040 with external QSPI flash and the required clock circuit.
- USB data protection, series components where required, and a clear return path.
- A labelled SWD debug header and reset/boot controls.
- One programmable status LED.
- A labelled four-pin 3.3 V/GND/SDA/SCL expansion header, with I2C pull-ups.
- Ground plane, labelled connectors and at least two mounting holes, within an
  approximately 55 by 40 mm outline.

Firmware should provide a minimal status indication and an I2C scan/report path.
Document the supported toolchain and how the generated firmware would be built;
do not claim compilation or device execution unless actually performed.

Follow all eight native Copperhead stages from brief through dev-plan. Preserve
the stage commits, run summaries, tool logs and provider cache. Do not edit the
generated artifacts by hand to force completion. ERC and DRC must run on the
actual generated project; an empty design must never count as a clean gate.

The final report must distinguish verified software checks from assumptions about
electrical performance, fabrication and physical hardware. Any unresolved design
or tool failure stays explicit rather than being converted into a successful stage.

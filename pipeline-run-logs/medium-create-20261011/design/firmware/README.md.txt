# ESP32-C3 environmental display firmware

Applicable to programmable U1 ESP32-C3-MINI-1-N4X. ESP-IDF 5.5.3 / ESP32-C3 GCC14.2.0 is the selected supplied framework; PROJECT_VER is fixed at0.1.0 and sdkconfig.defaults enables CONFIG_APP_REPRODUCIBLE_BUILD. Rationale: use the installed SDK and supported reproducibility configuration, then verify actual independent binary equality.

## Pin authority and build

docs/PINOUT.md is the single source of truth. tools/generate_pins.py parses its U1 table at CMake configure time, generates build/generated/pins.h and compares the committed firmware/pins.h snapshot. Missing/duplicate mappings, reserved-pin conflicts or stale snapshots fail configuration. No package pin is mistaken for a GPIO. UART0 logs use ESP-IDF default UART pads corresponding to RXD0/TXD0; no UART pad remapping or strap writes occur. Rationale: prevent silent pin drift and preserve the buffered UART circuit.

Build from firmware with the operator's supplied ESP-IDF5.5.3 environment using idf.py build. The Copperhead build_firmware tool performs isolated builds and saves actual logs/source/PINOUT/binary hashes. Build status and reproducibility are recorded in docs/DEVPLAN.md after the tool returns; configuration alone is not build evidence. Source/PINOUT changes require rebuilding. No install or flash is performed.

## Drivers and working path

board_hal exposes GPIO/reset/fault and bounded100ms legacy I2C transfers. Functional drivers implement SHT40 high-precision heater-off command0xFD,10ms conversion wait, six-byte read, independent temperature/RH CRC8 checks (polynomial0x31, initial0xFF), Celsius conversion and physical RH reporting clamp. CRC self-check uses BE EF ->92. A single bus-owning task samples every1s and renders every500ms using absolute task deadlines; no WiFi/Bluetooth operation is started. Real physical cadence under errors/load must be checked.

The OLED driver initializes a128x64 SSD1306-compatible display, clears/rewrites all eight pages and draws temperature, RH, SENSOR ERROR and POWER FAULT using included glyphs. CRC/bus errors invalidate the sample immediately, suppress old numeric values, log an error and retry next sample. Display failures are logged and initialization retried at the next refresh; an unreachable display cannot physically show an error. Rationale: functional driver scaffolding supplies a happy path and explicit failure behavior rather than fabricated measurements.

ASSUMED SHT40 address0x44; external OLED address0x3C, SSD1306-compatible128x64 charge-pump controller, contrast0x20 and default UART115200. Actual sensor suffix and OLED revision/address/reset/supply/cable/pullups must be verified before use. No alternate address auto-detection or unreviewed heater/radio command is added. Contrast selection is not proof of<=50mA.

External R10/R11 provide I2C pullups; internal pulls remain disabled. GPIO2/8/9 remain reserved boot straps; RESET/BOOT remain manual. FAULT_N uses existing R4. The board has93 unrouted connections and cannot operate as submitted. Startup/recycle<=450mA,250mA continuous input,222/472mA rail envelope,82% conversion target, reset behavior, per-part leakage, module/source qualification and RF/mechanical requirements remain open. Build success proves neither hardware operation nor power compliance.

# Pinout

Pin assignment extracted from the schematic. Check strapping/RTC notes before
reassigning pins.

| Refdes | Pin | Name | Net | Notes |
|---|---|---|---|---|
| U1 | 1 | 3V3 | 3V3 | Main 3.3V rail |
| U1 | 2 | EN | EN | Enable line with pullup |
| U1 | 3 | GPIO0 | | Strapping pin (boot mode) — forbidden for key |
| U1 | 4 | GPIO3 | | Strapping pin (JTAG) — forbidden for key |
| U1 | 5 | GPIO14 | KEY_IN | Current key input (RTC_GPIO14) |
| U1 | 6 | GPIO18 | | RTC_GPIO18 (RTC capable, available) |
| U1 | 7 | GPIO21 | | RTC_GPIO21 (RTC capable, available) |
| U1 | 8 | GND | GND | Ground |
| U1 | 9 | GPIO45 | | Strapping pin (VDD_SPI) — forbidden |
| U1 | 10 | GPIO46 | | Strapping pin (ROM log) — forbidden |
| U1 | 11 | GPIO1 | | RTC_GPIO1 (RTC capable, available) |
| U1 | 12 | GPIO2 | | RTC_GPIO2 (RTC capable, available) |

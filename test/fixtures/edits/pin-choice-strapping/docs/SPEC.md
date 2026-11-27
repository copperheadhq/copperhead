# pin-choice-strapping — Specification

ESP32-S3 keyer design with deep-sleep wakeup requirements. Key input must be connected to an RTC-capable GPIO and strictly avoid boot strapping pins.

## Strapping pins

The following pins are ESP32-S3 strapping pins and MUST NOT be used for the key input or pulled low at boot:

- GPIO0 (strapping: boot mode selection)
- GPIO3 (strapping: JTAG configuration)
- GPIO45 (strapping: VDD_SPI voltage)
- GPIO46 (strapping: ROM message printing)

## RTC-capable GPIOs

ESP32-S3 RTC GPIOs available for deep-sleep wakeup:

- GPIO0 (RTC_GPIO0, strapping: forbidden)
- GPIO3 (RTC_GPIO3, strapping: forbidden)
- GPIO1 (RTC_GPIO1, available)
- GPIO2 (RTC_GPIO2, available)
- GPIO14 (RTC_GPIO14, current key input)
- GPIO18 (RTC_GPIO18, available)
- GPIO21 (RTC_GPIO21, available)

## Budgets

<!-- Hard budgets -->

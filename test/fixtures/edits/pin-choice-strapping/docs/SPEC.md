# pin-choice-strapping — Specification

ESP32-S3 keyer design with deep-sleep wakeup requirements. Key input must be connected to an RTC-capable GPIO (`rtc_capable`) and strictly avoid boot strapping pins.

## Strapping pins

The following pins are ESP32-S3 strapping pins and MUST NOT be used for the key input or pulled low at boot:

- GPIO0 (IO0, strapping: boot mode selection)
- GPIO3 (IO3, strapping: JTAG configuration)
- GPIO45 (IO45, strapping: VDD_SPI voltage)
- GPIO46 (IO46, strapping: ROM message printing)

## RTC-capable GPIOs

ESP32-S3 RTC GPIOs available for deep-sleep wakeup (`rtc_capable`):

- GPIO0 (IO0, RTC_GPIO0, strapping: forbidden)
- GPIO3 (IO3, RTC_GPIO3, strapping: forbidden)
- GPIO1 (IO1, RTC_GPIO1)
- GPIO2 (IO2, RTC_GPIO2)
- GPIO14 (IO14, RTC_GPIO14)
- GPIO18 (IO18, RTC_GPIO18)
- GPIO21 (IO21, RTC_GPIO21)

## Budgets

<!-- Hard budgets -->

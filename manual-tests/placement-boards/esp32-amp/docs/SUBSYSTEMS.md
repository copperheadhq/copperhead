# Subsystems

## Power Input

USB-C receptacle with CC pulldowns, a resettable fuse, a bidirectional TVS, and the 5V bulk capacitor. The 5V rail feeds the amplifier directly; everything else runs off 3V3.

## Regulation

AP2112K-3.3 LDO from 5V to 3V3 with input and output capacitors and a rail indicator LED.

## MCU

ESP32-S3-WROOM-1 with its decoupling, the EN reset network, BOOT and RESET buttons, and a UART header. USB D+/D- come straight off the receptacle.

## Amplifier

MAX98357A I2S class-D amplifier on the 5V rail: decoupling, the gain-select resistor, and the SD_MODE divider that picks the left channel.

## Speaker Output

Ferrite-bead EMI filter on the bridged outputs into a 2-pin screw terminal.

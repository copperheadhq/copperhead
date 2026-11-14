# Subsystems

## Power Input

USB Micro-B power entry with polyfuse protection and bulk storage. Data pins unused: this node powers from USB but talks over the FTDI header.

## Regulation

AMS1117-3.3 linear regulator dropping the fused 5V bus to the 3.3V rail, with input and output ceramics.

## MCU

ATmega328P (TQFP-32) with supply decoupling, AREF filtering, the reset pull-up shared with the ISP header, and the supply-sense divider into ADC6.

## Clock

16MHz crystal with its two load capacitors.

## IO Headers

I2C header with bus pull-ups, FTDI serial header, and the 2x3 ISP programming header.

## Status

Always-on 3.3V rail indicator LED with its series resistor.

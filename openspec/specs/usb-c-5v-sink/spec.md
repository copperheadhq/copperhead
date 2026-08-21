# USB-C 5 V Sink

## Requirements

### Valid sink presentation

Given a compliant USB-C source is connected, when the board presents 5.1 kOhm Rd from CC1 and CC2 to GND, then the source can detect a sink and enable 5 V VBUS.

### Power-only interface

Given the board operates normally, when connected to USB-C, then it shall use VBUS, GND, CC1, and CC2 only and shall not provide data pass-through or USB-PD negotiation.

### Current disclosure

Given the board does not read Rp, when a source advertises less than 3 A, then the board shall not claim to negotiate or guarantee 3 A availability.

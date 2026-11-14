# BOM

| Refdes | Value | Footprint | MPN | Rationale |
| --- | --- | --- | --- | --- |
| J1 | USB_B_Micro | Connector_USB:USB_Micro-B_Amphenol_10118193-0001LF_Horizontal | UNVERIFIED | USB power entry |
| F1 | 500mA | Fuse:Fuse_1206_3216Metric | UNVERIFIED | polyfuse, VBUS inrush and fault protection |
| CP1 | 47u/16V | Capacitor_SMD:CP_Elec_6.3x7.7 | UNVERIFIED | bulk storage on the fused bus |
| U2 | AMS1117-3.3 | Package_TO_SOT_SMD:SOT-223-3_TabPin2 | UNVERIFIED | 3.3V LDO |
| C1 | 10u/16V | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | LDO input ceramic |
| C2 | 10u/16V | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | LDO output ceramic |
| U1 | ATmega328P-A | Package_QFP:TQFP-32_7x7mm_P0.8mm | UNVERIFIED | main microcontroller |
| C3 | 100n | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | VCC decoupling |
| C4 | 100n | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | AVCC decoupling |
| C6 | 100n | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | AREF filter |
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | reset pull-up |
| R4 | 100k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | supply-sense divider upper |
| R5 | 47k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | supply-sense divider lower |
| Y1 | 16MHz | Crystal:Crystal_SMD_HC49-SD | UNVERIFIED | system clock |
| C7 | 22p | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | crystal load |
| C8 | 22p | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | crystal load |
| J2 | Conn_01x04 | Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical | UNVERIFIED | I2C header |
| R2 | 4k7 | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | SDA pull-up |
| R6 | 4k7 | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | SCL pull-up |
| J3 | Conn_01x06 | Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical | UNVERIFIED | FTDI serial header |
| J4 | Conn_02x03_Odd_Even | Connector_PinHeader_2.54mm:PinHeader_2x03_P2.54mm_Vertical | UNVERIFIED | ISP programming header |
| R3 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | LED series resistor |
| D1 | green | LED_SMD:LED_0603_1608Metric | UNVERIFIED | 3.3V rail indicator |

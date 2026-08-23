# BOM

| Refdes | Value | Footprint | MPN | Rationale |
| --- | --- | --- | --- | --- |
| J1 | Conn_01x02 | TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-2-5.08_1x02_P5.08mm_Horizontal | UNVERIFIED | 12V input |
| CP1 | 100u/25V | Capacitor_SMD:CP_Elec_8x10.5 | UNVERIFIED | input bulk |
| C1 | 10u/50V | Capacitor_SMD:C_1210_3225Metric | UNVERIFIED | input ceramic |
| C2 | 10u/50V | Capacitor_SMD:C_1210_3225Metric | UNVERIFIED | input ceramic |
| C3 | 100n/50V | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | VIN high-frequency bypass |
| R1 | 402k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | EN divider upper, UVLO rising |
| R2 | 54k9 | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | EN divider lower |
| U1 | TPS54560BDDA | Package_SO:Texas_R-PDSO-G8_EP2.95x4.9mm_Mask2.4x3.1mm_ThermalVias | UNVERIFIED | 60V 5A step-down converter |
| C4 | 100n/25V | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | bootstrap |
| R3 | 301k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | RT/CLK, 400kHz |
| R4 | 4k99 | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | compensation zero resistor |
| C5 | 3n3 | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | compensation zero capacitor |
| C6 | 47p | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | compensation high-frequency pole |
| D1 | B560C | Diode_SMD:D_SMC | UNVERIFIED | catch diode, 5A 60V Schottky |
| L1 | 6u8 | Inductor_SMD:L_Bourns_SRP1245A | UNVERIFIED | power inductor, 8A saturation |
| C7 | 47u/16V | Capacitor_SMD:C_1210_3225Metric | UNVERIFIED | output ceramic |
| C8 | 47u/16V | Capacitor_SMD:C_1210_3225Metric | UNVERIFIED | output ceramic |
| C9 | 100n/16V | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | output high-frequency bypass |
| R5 | 52k3 | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | feedback divider upper |
| R6 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | feedback divider lower |
| C10 | 47p | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | feedback feedforward |
| R7 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | LED series resistor |
| D2 | green | LED_SMD:LED_0603_1608Metric | UNVERIFIED | 5V rail indicator |
| J2 | Conn_01x02 | TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-2-5.08_1x02_P5.08mm_Horizontal | UNVERIFIED | 5V load output |

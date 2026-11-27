# Layout

copperhead placed every schematic part onto `esp32-amp.kicad_pcb` on a grid (68 x 64 mm outline, all on F.Cu, nothing routed) so the layout stage edits placements rather than authoring footprints. Coordinates are a starting point, not a design.

## Footprints

| Refdes | Value | Footprint on the board | How chosen |
|---|---|---|---|
| U1 | ESP32-S3-WROOM-1 | RF_Module:ESP32-S3-WROOM-1 | schematic Footprint field |
| J1 | USB_C_Receptacle | Connector_USB:USB_C_Receptacle_HCTL_HC-TYPE-C-16P-01A | schematic Footprint field |
| CP1 | 100u/10V | Capacitor_SMD:CP_Elec_6.3x7.7 | schematic Footprint field |
| J2 | Conn_01x02 | TerminalBlock_Phoenix:TerminalBlock_Phoenix_MPT-0,5-2-2.54_1x02_P2.54mm_Horizontal | schematic Footprint field |
| J3 | Conn_01x04 | Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical | schematic Footprint field |
| F1 | 1A1 | Fuse:Fuse_1812_4532Metric | schematic Footprint field |
| SW1 | BOOT | Button_Switch_SMD:SW_Push_1P1T_NO_CK_KMR2 | schematic Footprint field |
| SW2 | RESET | Button_Switch_SMD:SW_Push_1P1T_NO_CK_KMR2 | schematic Footprint field |
| U3 | MAX98357A | Package_DFN_QFN:TQFN-16-1EP_3x3mm_P0.5mm_EP1.23x1.23mm | schematic Footprint field |
| U2 | AP2112K-3.3 | Package_TO_SOT_SMD:SOT-23-5 | schematic Footprint field |
| D1 | SMF5.0A | Diode_SMD:D_SOD-123 | schematic Footprint field |
| C2 | 10u | Capacitor_SMD:C_0805_2012Metric | schematic Footprint field |
| C4 | 22u | Capacitor_SMD:C_0805_2012Metric | schematic Footprint field |
| C7 | 10u | Capacitor_SMD:C_0805_2012Metric | schematic Footprint field |
| FB1 | 600R/1A | Inductor_SMD:L_0805_2012Metric | schematic Footprint field |
| FB2 | 600R/1A | Inductor_SMD:L_0805_2012Metric | schematic Footprint field |
| C1 | 1u | Capacitor_SMD:C_0603_1608Metric | schematic Footprint field |
| D2 | GREEN | LED_SMD:LED_0603_1608Metric | schematic Footprint field |
| R3 | 1k | Resistor_SMD:R_0603_1608Metric | schematic Footprint field |
| R1 | 5k1 | Resistor_SMD:R_0402_1005Metric | schematic Footprint field |
| R2 | 5k1 | Resistor_SMD:R_0402_1005Metric | schematic Footprint field |
| R4 | 10k | Resistor_SMD:R_0402_1005Metric | schematic Footprint field |
| R5 | 100k | Resistor_SMD:R_0402_1005Metric | schematic Footprint field |
| R6 | 1M | Resistor_SMD:R_0402_1005Metric | schematic Footprint field |
| R7 | 100k | Resistor_SMD:R_0402_1005Metric | schematic Footprint field |
| C3 | 100n | Capacitor_SMD:C_0402_1005Metric | schematic Footprint field |
| C5 | 1u | Capacitor_SMD:C_0402_1005Metric | schematic Footprint field |
| C6 | 100n | Capacitor_SMD:C_0402_1005Metric | schematic Footprint field |
| C8 | 1n | Capacitor_SMD:C_0402_1005Metric | schematic Footprint field |
| C9 | 1n | Capacitor_SMD:C_0402_1005Metric | schematic Footprint field |

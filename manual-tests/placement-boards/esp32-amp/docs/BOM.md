# BOM

| Refdes | Value | Footprint | MPN | Rationale |
| --- | --- | --- | --- | --- |
| J1 | USB_C_Receptacle | Connector_USB:USB_C_Receptacle_HCTL_HC-TYPE-C-16P-01A | UNVERIFIED | 5V input, USB 2.0 data to the module |
| R1 | 5k1 | Resistor_SMD:R_0402_1005Metric | UNVERIFIED | CC1 pulldown, advertises a sink |
| R2 | 5k1 | Resistor_SMD:R_0402_1005Metric | UNVERIFIED | CC2 pulldown, advertises a sink |
| F1 | 1A1 | Fuse:Fuse_1812_4532Metric | UNVERIFIED | resettable fuse on VBUS |
| D1 | SMF5.0A | Diode_SMD:D_SOD-123 | UNVERIFIED | bidirectional TVS on the 5V rail |
| CP1 | 100u/10V | Capacitor_SMD:CP_Elec_6.3x7.7 | UNVERIFIED | bulk reservoir for the class-D output stage |
| U2 | AP2112K-3.3 | Package_TO_SOT_SMD:SOT-23-5 | UNVERIFIED | 600 mA 3V3 LDO for the module |
| C1 | 1u | Capacitor_SMD:C_0603_1608Metric | UNVERIFIED | LDO input capacitor |
| C2 | 10u | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | LDO output capacitor |
| R3 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | rail LED series resistor |
| D2 | GREEN | LED_SMD:LED_0603_1608Metric | UNVERIFIED | 3V3 rail indicator |
| U1 | ESP32-S3-WROOM-1 | RF_Module:ESP32-S3-WROOM-1 | UNVERIFIED | Wi-Fi SoC module, I2S master |
| C3 | 100n | Capacitor_SMD:C_0402_1005Metric | UNVERIFIED | module decoupling |
| C4 | 22u | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | module bulk decoupling for Wi-Fi bursts |
| R4 | 10k | Resistor_SMD:R_0402_1005Metric | UNVERIFIED | EN pullup |
| C5 | 1u | Capacitor_SMD:C_0402_1005Metric | UNVERIFIED | EN power-on delay |
| SW1 | BOOT | Button_Switch_SMD:SW_Push_1P1T_NO_CK_KMR2 | UNVERIFIED | pulls IO0 low for download mode |
| SW2 | RESET | Button_Switch_SMD:SW_Push_1P1T_NO_CK_KMR2 | UNVERIFIED | pulls EN low |
| J3 | Conn_01x04 | Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical | UNVERIFIED | UART0 programming header |
| U3 | MAX98357A | Package_DFN_QFN:TQFN-16-1EP_3x3mm_P0.5mm_EP1.23x1.23mm | UNVERIFIED | 3.2W I2S class-D amplifier |
| C6 | 100n | Capacitor_SMD:C_0402_1005Metric | UNVERIFIED | amplifier decoupling |
| C7 | 10u | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | amplifier bulk decoupling |
| R5 | 100k | Resistor_SMD:R_0402_1005Metric | UNVERIFIED | GAIN_SLOT to GND, 12 dB gain |
| R6 | 1M | Resistor_SMD:R_0402_1005Metric | UNVERIFIED | SD_MODE divider upper leg |
| R7 | 100k | Resistor_SMD:R_0402_1005Metric | UNVERIFIED | SD_MODE divider lower leg, selects left channel |
| FB1 | 600R/1A | Inductor_SMD:L_0805_2012Metric | UNVERIFIED | EMI filter on OUTP |
| FB2 | 600R/1A | Inductor_SMD:L_0805_2012Metric | UNVERIFIED | EMI filter on OUTN |
| C8 | 1n | Capacitor_SMD:C_0402_1005Metric | UNVERIFIED | output filter cap on SPK_P |
| C9 | 1n | Capacitor_SMD:C_0402_1005Metric | UNVERIFIED | output filter cap on SPK_N |
| J2 | Conn_01x02 | TerminalBlock_Phoenix:TerminalBlock_Phoenix_MPT-0,5-2-2.54_1x02_P2.54mm_Horizontal | UNVERIFIED | speaker terminal |

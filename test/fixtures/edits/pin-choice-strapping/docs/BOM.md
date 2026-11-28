# Bill of Materials

Every part: refdes, MPN, value, package, and WHY it was chosen. MPNs the agent
introduces without a datasheet check are flagged UNVERIFIED.

Value holds the component value only ("4.7uF", "1M", "500mAh Li-Po") — the
schematic stage draws it as the symbol's Value field, so a description there
collides with neighbouring symbols and fails the legibility gate. Prose belongs
in Rationale. One row per refdes; a grouped row ("C5-C8") matches no symbol.

| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| R2 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| U1 | ESP32-S3-WROOM-1 | RF_Module:ESP32-S3-WROOM-1 | UNVERIFIED | extracted from schematic by copperhead init |

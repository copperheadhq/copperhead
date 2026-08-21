# USB-C 5 V Power Breakout — Specification

## Device

A compact USB-C power-only sink breakout. It accepts default USB-C VBUS at 5 V and presents 5 V/GND on a 2-pin, 3.5 mm screw terminal and a 2×2, 2.54 mm (0.1 in) header for breadboard projects. USB data, USB Power Delivery, other output voltages, and an enclosure are intentionally out of scope.

## Functional requirements

- Use a USB-C receptacle as a sink/UFP and accept 5 V only.
- Fit one 5.1 kOhm Rd pull-down from CC1 to GND and one from CC2 to GND; this is the standard default-sink presentation that enables VBUS from a compliant source.
- Route VBUS and GND to both output connectors.
- Provide a visible power-present LED.
- Protect against an output short circuit. **ASSUMED:** use a resettable PTC with >=3 A hold current and <=6 A trip current; final selection must meet voltage, thermal, area, and cost limits.

## Electrical budgets

| Constraint | Requirement | Status |
|---|---:|---|
| Input voltage | 5 V nominal; survive 6 V | Stated |
| Output-current capability | 3 A continuous through connector, protection, copper, and output terminals | Stated |
| No-load quiescent current | <2 mA total, including LED | Stated |
| CC termination | 5.1 kOhm Rd from each CC pin to GND | ASSUMED standard USB-C value |
| Short protection | Resettable PTC: >=3 A hold, <=6 A trip | ASSUMED |
| Ambient operating range | 0 to 50 °C | ASSUMED |

### USB-C current availability

The 3 A rating is the board’s component-and-copper capability, not a promise that every USB-C source supplies 3 A. This passive sink neither reads the source Rp advertisement nor negotiates USB-PD. The source and connected load must be compatible; a source may advertise only default USB current or 1.5 A.

## Mechanical, manufacturing, and cost constraints

| Constraint | Requirement | Status |
|---|---:|---|
| Board outline | <=30 mm × 20 mm | Stated |
| PCB build | 2 layers, 1 oz copper, standard JLCPCB process | Stated |
| Routing | No controlled impedance | Stated |
| Assembly | Nothing finer than 0603; no BGA; no QFN with exposed thermal pad | Stated |
| Target BOM cost | <US$3 at quantity 100 | Stated |
| Mounting | 2 × through-hole M3 holes, 24 mm pitch | Stated |

## Interfaces

- Input: USB-C receptacle; use VBUS, GND, CC1, and CC2 only. D+/D− and SBU are intentionally unconnected.
- Output A: 2-pin, 3.5 mm screw terminal carrying 5 V and GND.
- Output B: 2×2, 2.54 mm header carrying duplicated 5 V and GND pins. **ASSUMED:** duplication improves breadboard-wiring convenience.

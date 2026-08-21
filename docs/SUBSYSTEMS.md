# Subsystems and architecture

## Block diagram in prose

USB-C receptacle → CC sink presentation and VBUS/GND entry → resettable PTC on the positive rail → protected `+5V_OUT` distribution → screw-terminal and duplicated-pin header outputs. The unprotected input rail also feeds a low-current power-present LED branch; all return paths join the common GND plane. USB data (D+/D−), SBU, USB-PD negotiation, MCU, firmware, wireless connectivity, and regulated secondary rails are intentionally absent.

This is a passive USB-C 5 V breakout, not a power negotiator: the source detects Rd on CC1 or CC2 before it enables VBUS, while the downstream load must remain compatible with the source’s advertised current. The board is designed for 3 A component-and-copper capability, but does not promise that every source can deliver 3 A.

## Power input and USB-C sink

- **Function:** accept USB-C VBUS at 5 V nominal and survive 6 V, using VBUS, GND, CC1, and CC2 only.
- **Key values:** one 5.1 kOhm Rd resistor from each CC pin to GND; input range 5–6 V.
- **Reasoning:** 5.1 kOhm Rd is the standard default-UFP/sink termination, allowing a compliant source to enable VBUS without USB-PD circuitry. CC termination does not advertise or negotiate a guaranteed 3 A supply.
- **Intentional omissions:** D+/D− and SBU are left unconnected because data and alternate modes are out of scope; no PD controller is fitted because only default 5 V input is required.

## Protection and 5 V distribution

- **Function:** place a resettable PTC in series with VBUS before the user-accessible output rail, then distribute the protected rail as `+5V_OUT`.
- **Key values:** PTC hold current >=3 A and trip current <=6 A (assumed pending final part selection); output path rated for 3 A continuous.
- **Reasoning:** the series PTC limits sustained output-short energy while preserving the specified 3 A continuous capability under the 0–50 °C operating assumption. Final selection must also satisfy 6 V survival, thermal derating, board area, package restrictions, and the <US$3/100 BOM target.
- **Budget guardrail:** no active power controller, regulator, or reverse-current IC is included; this avoids adding quiescent current to the <2 mA no-load budget.

## Output interfaces

- **Function:** expose protected `+5V_OUT` and GND through a 2-pin, 3.5 mm screw terminal and a 2×2, 2.54 mm header.
- **Key values:** the header duplicates 5 V and GND pins; both outputs share the same protected 3 A-capable rail.
- **Reasoning:** the terminal is the primary wired-load interface, while duplicated header pins improve breadboard wiring convenience without creating a second power domain. Connector ratings and copper width must each support 3 A continuous.

## UI: power-present indicator

- **Function:** indicate that the input-side 5 V rail is present using one LED and series resistor.
- **Key values:** target approximately 1 mA LED current at 5 V; a nominal green LED with a 3.3 kOhm series resistor is the architecture baseline (about 0.9 mA at 5 V and 1.2 mA at 6 V, subject to final LED forward-voltage verification).
- **Reasoning:** a visible indicator is required, and a ~1 mA branch leaves substantial margin below the <2 mA total no-load quiescent-current limit. The final LED and resistor must be checked at the 6 V maximum input and over LED forward-voltage tolerance.

## MCU and firmware

- **Status:** intentionally absent.
- **Reasoning:** no sensing, negotiation, regulation control, configuration, or firmware behavior is required for a passive 5 V breakout. Omitting an MCU eliminates its sleep current, programming interface, and strapping-pin risks.

## Connectivity and data

- **Status:** intentionally absent.
- **Reasoning:** the product is power-only; USB data, wireless links, and external communications would add cost, area, leakage, and compliance scope without serving a stated requirement.

## Mechanical and PCB implementation

- **Function:** place the receptacle, protection, outputs, LED, and two mounting holes on a compact low-cost board.
- **Key values:** maximum 30 × 20 mm; two layers; 1 oz copper; standard JLCPCB process; two through-hole M3 mounting holes on 24 mm pitch.
- **Reasoning:** these constraints favor short, wide high-current paths from receptacle through PTC to outputs and rule out dependence on controlled-impedance routing. Components must be no finer than 0603 and must not use BGA or QFN with exposed thermal pad. USB-C receptacle keepout, connector access, mounting-hole clearance, and 3 A copper thermal performance remain PCB-placement and routing checks.

## Budget summary

The architecture reserves the no-load budget primarily for the LED branch (<1.3 mA at 6 V nominal baseline) and intentionally selects no other continuous-load circuitry. The PTC, output connectors, and passive copper distribution add no material quiescent draw. Final schematic and BOM selection must demonstrate total no-load current below 2 mA, 3 A continuous capability through every series element and connector, 6 V input survival, PTC thermal suitability at 0–50 °C, and BOM cost below US$3 at quantity 100.

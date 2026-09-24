# Circuit Pattern Library

This directory contains static reference definitions of standard, proven circuit blocks under `src/kicad/patterns/`.

## Overview

Each pattern file defines a self-contained circuit block using the declarative component (`parts`) and netlist (`nets`) structure compatible with `SchematicIntent`.

All pattern files are validated against `src/kicad/patterns/pattern.schema.json` via:

```bash
npm run validate:patterns
```

## Available Patterns

| Pattern File | Pattern Name | Description | Part Count |
|:---|:---|:---|:---:|
| `voltage-regulator-ams1117.json` | `voltage-regulator-ams1117` | AMS1117 3.3V linear voltage regulator subcircuit with input and output ceramic decoupling capacitors. | 3 |
| `usb-c-power-input.json` | `usb-c-power-input` | USB Type-C 16-pin USB 2.0 power input sink block with 5.1k CC1/CC2 pull-down resistors and VBUS bulk capacitor. | 4 |
| `crystal-oscillator.json` | `crystal-oscillator` | Standard crystal oscillator resonant circuit with dual load capacitors, matching canonical crystal flanking topology. | 3 |

## Using Patterns During Part-Selection

During Stage 3 (`part-selection`), circuit patterns can be referenced directly by name instead of enumerating every part by hand:

```bash
copperhead create --stage part-selection
# Output:
# Resolved pattern "voltage-regulator-ams1117" -> 3 parts added to BOM.md
```

### Before and After in `BOM.md`

**Before resolution:**
```markdown
| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| U2 | ESP32-WROOM-32 | RF_Module:ESP32-WROOM-32 | ESP32-WROOM-32D | Main MCU |
use pattern: voltage-regulator-ams1117
```

**After resolution:**
```markdown
| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| U2 | ESP32-WROOM-32 | RF_Module:ESP32-WROOM-32 | ESP32-WROOM-32D | Main MCU |
| Pattern: voltage-regulator-ams1117 | source: src/kicad/patterns/voltage-regulator-ams1117.json |
| U1 | AMS1117-3.3 | Package_TO_SOT_SMD:SOT-223-3_TabPin2 | UNVERIFIED | from pattern: voltage-regulator-ams1117 |
| C1 | 10u | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | from pattern: voltage-regulator-ams1117 |
| C2 | 10u | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | from pattern: voltage-regulator-ams1117 |
```

Expanded rows are tagged with `from pattern: <name>` in the Rationale column for full traceability and flow directly into Stage 4 unchanged.

## Schema and Structure

Pattern files follow the top-level schema defined in `src/kicad/patterns/pattern.schema.json`:

```json
{
  "name": "pattern-identifier",
  "description": "Human-readable description of the subcircuit.",
  "parts": [
    {
      "ref": "U1",
      "libId": "Regulator_Linear:AMS1117-3.3",
      "value": "AMS1117-3.3",
      "footprint": "Package_TO_SOT_SMD:SOT-223-3_TabPin2",
      "group": "Power"
    }
  ],
  "nets": [
    {
      "name": "VIN",
      "pins": ["U1.3", "C1.1"],
      "kind": "power"
    }
  ]
}
```

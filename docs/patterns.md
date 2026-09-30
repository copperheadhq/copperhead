# Circuit Pattern Library

This directory contains static, read-only reference definitions of standard, proven circuit blocks under `src/kicad/patterns/`.

> [!IMPORTANT]
> **Read-Only Reference Corpus**
>
> These are read-only reference data. Consuming these patterns from part-selection or the schematic drafting step is a separate, future proposal (see [issue #274](https://github.com/copperheadhq/copperhead/issues/274)) and is not implemented here.

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

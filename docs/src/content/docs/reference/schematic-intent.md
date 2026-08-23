---
title: The schematic intent file
description: The full specification of schematic.intent.json, the netlist-intent IR the deterministic drafting engine takes as its only input.
sidebar:
  order: 5
---

:::note
Specified by the `deterministic-schematic-drafting` OpenSpec change; the binding requirements live in that change's `schematic-drafting-engine` delta spec and merge into SPEC.md on archive. The executable contract is `src/kicad/draft/ir.ts`: there is deliberately no separate JSON Schema file, because the validator is the schema and it reports violations as numbered findings rather than opaque rejections. How the engine turns this file into a sheet is described in [How schematics are drafted](/reference/schematic-drafting/).
:::

`schematic.intent.json` is the single source of drafting truth: a compact, versioned JSON document naming which parts exist, which pins connect, and which subsystem each part belongs to. It contains no coordinates, ever. The deterministic engine computes every position, wire, label, power symbol, and group box from it, and re-drafting the same intent fully regenerates the sheet, byte for byte, on any machine.

## Location and entry points

The file lives beside the configured schematic (for `hardware/board.kicad_sch`, the default path is `hardware/schematic.intent.json`). Three entry points consume it:

- `copperhead draft schematic` reads it from the default path, or from `--intent <repo-relative-path>`.
- The `draft_schematic` agent tool accepts the full document inline as `intent_json` and writes it to the default path before drafting.
- The create pipeline's stage-4 completeness probe re-drafts it in memory to detect a stale sheet; that probe writes nothing.

## Top-level shape

```json
{
  "version": 1,
  "parts":     [ ... ],
  "nets":      [ ... ],
  "noConnect": [ ... ],
  "hints":     { ... }
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `version` | number | yes | IR schema version. This engine supports exactly `1`; any other value is refused with a message naming the supported version, and nothing is written. |
| `parts` | array | yes | Every symbol to place. |
| `nets` | array | yes | Every connection, as named nets over `"REF.PIN"` endpoints. |
| `noConnect` | array of strings | no | Pins deliberately left open. |
| `hints` | object | no | Optional steering: group order, paper size, title-block date. |

Unknown extra fields are ignored. Every field the engine dereferences is type-checked at validation, so a wrong-typed field (a numeric `group`, a string `noConnect`) comes back as a numbered finding, never as a crash.

## `parts[]`

```json
{ "ref": "U1", "libId": "CopperMCU:MCU8", "value": "MCU8",
  "footprint": "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", "group": "MCU" }
```

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `ref` | string | yes | The refdes. Non-empty and unique across the document; a duplicate is refused. |
| `libId` | string | yes | Canonical KiCad `Library:Symbol` id (for example `Device:R`). Resolution checks the project's committed `sym-lib-cache/` first, then the installed KiCad libraries, vendoring the block on first use so later drafts are hermetic. A near-miss name is refused with the closest candidates listed. A derived (`extends`) symbol resolves by inheriting its base's geometry, up to 8 hops. |
| `value` | string | yes | The drawn Value field. Cross-checked against the part's BOM.md row (see below). |
| `footprint` | string | no | Passed through to the symbol's Footprint field verbatim. |
| `group` | string | see rules | The subsystem this part belongs to. Required for every part whose symbol is not a power symbol; when `docs/SUBSYSTEMS.md` exists, the value must match one of its headings (case-insensitive). Power symbols (a library symbol carrying the `power` flag, or any `power:` lib id) need no group. |

**The BOM cross-check.** When `docs/BOM.md` exists, every non-power part must be a row of its canonical Refdes table, and the IR `value` must agree with the BOM's Value cell after unit normalization (`1 MΩ`, `1 Mohm`, and `1M` are one value; encoding differences never refuse). The BOM cell must also be drawable: a cell that is clearly prose (a clause list with sentence-like clauses, or more than 24 characters containing a space) is refused with a finding that names BOM.md as the thing to fix, because the cell is drawn on the sheet as the symbol's Value text. A long single token such as `JST_PH_S2B-PH-K_1x02_P2.00mm` is a real part identifier and is always allowed.

## `nets[]`

```json
{ "name": "DIV", "pins": ["R1.2", "R2.1", "U1.3"], "kind": "signal" }
```

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `name` | string | yes | Non-empty and unique. Refused if it contains a quote, backslash, or control character: the name is drawn as label text and embedded verbatim in the generated power-symbol source, where those characters would corrupt the emitted file. |
| `pins` | array of strings | yes | Endpoints as `"REF.PIN"` (refdes, dot, pin number). At least two endpoints; `REF` must be a declared part; `PIN` must exist on the resolved symbol (the finding lists the symbol's actual pins when it does not); a pin may appear in at most one net. |
| `kind` | `"power"` \| `"ground"` \| `"signal"` | no | Overrides the automatic classification below. Any other value is refused. |

**Classification.** Without a `kind`, a net is power-class when any endpoint's library pin type is `power_in` or `power_out`; a power-class net whose name matches `gnd` or `vss` is ground, otherwise it is a rail. The draft report lists every net's resolved class, so a wrong inference is visible and correctable with one `kind` override.

**What the class means for drawing.** Power-class nets are never routed: every reached pin gets its own power-port symbol (rails up, grounds down), and a power net with no `power_out` driver gets one synthesized `PWR_FLAG` so ERC passes. Signal nets are drawn as real wires when they stay local (one group, at most four endpoints, within the 50.8mm span budget) and become matched net-label pairs otherwise.

**Sanitize-collision rule.** Each power-class net generates a symbol under a sanitized token (characters outside `A-Z a-z 0-9 _ + . -` become `_`). Two power-class nets whose names sanitize to the same token (for example `RAIL A` and `RAIL_A`) would share one symbol and quietly merge their rails, so the pair is refused.

## `noConnect[]`

```json
"noConnect": ["U1.4", "U1.5"]
```

An array of `"REF.PIN"` strings. Each pin must exist on its part and must not appear in any net; a pin that is both connected and declared no-connect is refused. Every entry is emitted as a KiCad `no_connect` marker at the pin's position, so a deliberately open pin passes ERC without hand intervention.

## `hints{}`

```json
"hints": { "groupOrder": ["Power", "MCU"], "paper": "A4", "date": "2026-07-31" }
```

| Field | Type | Rules |
| --- | --- | --- |
| `groupOrder` | array of strings | Left-to-right (then top-to-bottom, after shelf-wrapping) group order, matched case-insensitively. Wins over SUBSYSTEMS.md heading order; groups listed nowhere sort last by name. |
| `paper` | string | Pins the sheet to a standard size (`A5`, `A4`, `A3`, `A2`, `A1`, `A0`). A non-standard name is not an error: the engine notes it in the report and derives the paper from content, which is also the default when the hint is absent. |
| `date` | string | The title-block date. Part of the intent rather than the wall clock, so the same intent emits the same bytes on any day; when absent the engine stamps the fixed epoch `2020-01-01`. |

Hints steer, they never override a rule: the engine will not accept a hint that would break the grid, the gating families, or connectivity.

## Validation contract

Validation runs in full before any placement. It covers, in order: part shape and field types, duplicate refdes, symbol resolution, group membership, net shape and name safety, endpoint existence and exclusivity, the power sanitize-collision rule, no-connect consistency, hint types, and the BOM cross-check. Every violation becomes one numbered finding in the same shape as `verify_symbols` output, all findings are reported together rather than first-failure-only, and a failed validation writes nothing: the previous schematic, the intent file on disk, and the vendored cache are all untouched. The repair loop is always the same: fix the intent (or the doc the finding names), draft again.

## What is deliberately not in this file

Coordinates, rotations, wire routes, label positions, junctions, power-symbol placement, paper margins, and group box geometry are all computed by the engine and have no IR representation. There is no way to pin a symbol to a position, and that is the point: the drawing stays a pure function of the netlist intent, the vendored symbol geometry, and nothing else. If a gate finding seems to demand a geometry fix, the fix is always expressible in this file (rename a net, regroup a part, add a `kind` or a no-connect, shorten a BOM value) or it is an engine bug worth reporting with the intent that produced it.

## Complete example

```json
{
  "version": 1,
  "parts": [
    { "ref": "J1", "libId": "Connector_Generic:Conn_01x03", "value": "Conn_01x03",
      "footprint": "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", "group": "Power" },
    { "ref": "U1", "libId": "MCU_Microchip_ATtiny:ATtiny85-20SU", "value": "ATtiny85",
      "footprint": "Package_SO:SOIJ-8_5.3x5.3mm_P1.27mm", "group": "MCU" },
    { "ref": "R1", "libId": "Device:R", "value": "10k",
      "footprint": "Resistor_SMD:R_0603_1608Metric", "group": "MCU" },
    { "ref": "C1", "libId": "Device:C", "value": "100n",
      "footprint": "Capacitor_SMD:C_0402_1005Metric", "group": "MCU" }
  ],
  "nets": [
    { "name": "VCC",    "pins": ["J1.1", "U1.8", "C1.1", "R1.1"] },
    { "name": "GND",    "pins": ["J1.2", "U1.4", "C1.2"] },
    { "name": "nRESET", "pins": ["R1.2", "U1.1"], "kind": "signal" }
  ],
  "noConnect": ["U1.2", "U1.3", "U1.5", "U1.6", "U1.7"],
  "hints": { "groupOrder": ["Power", "MCU"], "date": "2026-07-31" }
}
```

`VCC` and `GND` classify as power from the MCU's pin types and become per-pin symbols with a `PWR_FLAG` each (the connector provides no `power_out` driver). `nRESET` is a two-endpoint local net, so it is drawn as a wire, and because R1 hangs between a rail and that pin, the idiom pass stacks it directly on U1's reset pin with its rail symbol above. The five unused pins carry `no_connect` markers. Re-running the draft with this exact file reproduces the sheet byte for byte.

## Version history

| `version` | Status | Notes |
| --- | --- | --- |
| `1` | current | Initial schema: parts, nets, noConnect, hints as specified on this page. |

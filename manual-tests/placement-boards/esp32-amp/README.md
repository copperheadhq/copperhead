# esp32-amp

An ESP32-S3 I2S class-D amplifier board, built as a placement subject. See [../README.md](../README.md) for how placement boards work and how to run one.

## The design

USB-C in, mono speaker out, five subsystems in signal-flow order:

| Subsystem | Parts | What it has to satisfy |
| --- | --- | --- |
| Power Input | J1, R1, R2, F1, D1, CP1 | receptacle on a board edge; CC pulldowns and the TVS at the receptacle; bulk cap feeding the class-D stage |
| Regulation | U2, C1, C2, R3, D2 | AP2112K-3.3 with its input and output caps at their own pins |
| MCU | U1, C3, C4, R4, C5, SW1, SW2, J3 | ESP32-S3-WROOM-1 decoupled at pad 2; EN network and buttons reachable; UART header on an edge |
| Amplifier | U3, C6, C7, R5, R6, R7 | MAX98357A on the 5V rail, decoupled at both VDD pads; select resistors at their high-impedance pins |
| Speaker Output | FB1, FB2, C8, C9, J2 | bridged output through an EMI filter into a terminal on the opposite edge from USB-C |

30 parts, 22 declared nets (57 after KiCad names the unconnected pins), 68 × 64 mm two-layer outline. The schematic passes ERC with 0 errors and 1 warning (the MAX98357A thermal pad is an Unspecified-type pin tied to GND — correct, and not suppressible from the intent IR).

`layout-intent.yaml` states the requirements above in the RFC 11 §7.3 intent language: three edge-fixed connectors, 18 attachments, two groups. It is **not** applied by default — see the generations below for why that matters.

## Regenerating the inputs

The committed schematic and grid board came from:

```bash
# 1. bootstrapKicadProject() scaffolds the empty project and wires config
# 2. draft the sheet from schematic.intent.json
copperhead --repo manual-tests/placement-boards/esp32-amp draft schematic
# 3. populateBoard() puts a resolved footprint for every part on a shelf-pack grid
```

Steps 1 and 3 have no CLI surface yet (they live inside `create`'s pipeline), so they were driven directly through `src/kicad/bootstrap.ts` and `src/kicad/board.ts`. Both are deterministic given the same installed KiCad libraries.

## Generations

One directory per build under `generations/`. Each holds `placed.kicad_pcb`, `before.png`/`after.png`, `ranking.json`, `place.log` and a summary table.

| Generation | Outcome | Selected | HPWL | Connector nearest its edge | What changed |
| --- | --- | --- | --- | --- | --- |
| `2026-09-16-9597b5f` | PASS | placer-reuse-pack | 596.3 mm | 2.68 mm (J1, west) | the first baseline |
| `2026-09-16-9597b5f-intent` | PARTIAL | none | — | 0.75 mm (edges honoured) | `layout-intent.yaml` applied; every candidate fails on `placer-attach` stacking same-pin siblings |
| `2026-09-16-connector-edges` | PASS | placer-reuse-pack | 635.7 mm | 0.75 mm (all three) | connector edges derived from block regions (ADR 0013) |

The wirelength went up between the first and third generations and that is the improvement: the first board was shorter because it packed the USB-C receptacle into the middle, where no plug reaches it.

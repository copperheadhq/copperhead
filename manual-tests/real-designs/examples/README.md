# Committed examples

Real boards the engine drafts cleanly, kept in the repo so the side-by-side comparison is browsable without installing KiCad's demos or running the sweep. Everything here is a verbatim copy of one sweep run's output: the report, the renders, the drafted schematic, and the IR the netlist reduced to.

Each example holds:

```
<board>/
  REPORT.md               outcome and netlist comparison, paths made relative
  schematic.intent.json   the IR extracted from the board's netlist
  drawn/board.kicad_sch   what the engine drafted, openable in KiCad
  render/drawn.png        the engine's drawing
  render/original*.png    the person's drawing, one per sheet
  LICENSE*                the board's own licence, where it ships one
```

## The boards, and why these

Every board here drafts with connectivity exact (lost=0, gained=0), and every one carries a licence that permits redistribution. "KiCad demo" means a board with no licence file of its own that the KiCad project distributes in the `kicad-demos` package; those are included on that provenance.

| Board | Parts | Licence |
| --- | --- | --- |
| `cm5_minima` | 84 | CERN-OHL-S 2.0 (see its `LICENSE.txt`) |
| `complex_hierarchy` | 68 | KiCad demo |
| `ecc83` | 15 | KiCad demo |
| `interf_u` | 24 | KiCad demo |
| `kit-dev-coldfire-xilinx_5213` | 160 | KiCad demo |
| `multichannel` | 114 | KiCad demo |
| `pic_programmer` | 63 | KiCad demo |
| `royalblue54L_feather` | 71 | CERN-OHL-P 2.0 (see its `LICENSE`) |
| `sonde xilinx` | 25 | KiCad demo |
| `tiny_tapeout` | 150 | Apache-2.0 (see its `LICENSE.txt`) |

These licences apply to the boards' design content, including the renders and the drafted schematic derived from it, not to the rest of this repository. `stickhub`, the other board that drafts cleanly, is CC BY-NC-SA and stays out of the repo: run `npm run realdesigns -- stickhub` to reproduce it locally.

## Regenerating

The sweep writes fresh output to `manual-tests/runs/real-designs/` (gitignored):

```bash
npm run realdesigns -- cm5_minima interf_u royalblue54L_feather
```

An example is updated by copying the run output over the committed one and making the `render/` paths in REPORT.md relative. The source projects come from the `kicad-demos` package at `/usr/share/kicad/demos`.

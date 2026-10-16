# ATmega328P safe feedback-placement benchmark

Run date: 2026-10-16. The frozen input is the Copperhead-generated initializer
output from schematic commit `58b69da`; no coordinates were manually authored.
It contains no routed copper and begins with KiCad DRC clean and 35 unrouted
connections.

## Result

| Measurement | Before | After | Change |
|---|---:|---:|---:|
| Universal hard findings | 0 | 0 | 0 |
| Universal warnings | 5 | 4 | -1 |
| Physical-pad HPWL | 250.667 mm | 234.202 mm | -16.465 mm (-6.57%) |
| Critical-net HPWL | 189.5025 mm | 172.0375 mm | -17.465 mm (-9.22%) |
| KiCad DRC violations | 0 | 0 | unchanged |
| Unrouted connections | 35 | 35 | unchanged |

The first two proposed checkpoints improved placement metrics but introduced
silkscreen overlaps. Exact KiCad feedback named the moved parts; the optimizer
restored checkpoint zero, locked those refs, and found the retained result on
DRC pass three. The final accepted sequence moved U1 and Y1 through four
accepted moves from 224 candidate evaluations (101 exact placement checks).

## Reproducibility

Ten fresh end-to-end runs from the frozen input produced:

- board SHA-256 `9453164c33a85d9a6613000fc6a1459bb59e1a1e69113b6baa090cd0194ae146`
- tool-result SHA-256 `2fef6ed11047462ed80b6c61b08ffcb139b50a42f753911d35c85ce70753ba17`
- KiCad DRC clean on every run
- 35 unrouted connections on every run

Raw run evidence is staged outside the repository under
`/tmp/copperhead-safe-placement-atmega-rQoaY4/`.

# 2026-09-16-9597b5f-intent

- commit `9597b5f`
- `copperhead pcb place --mode race --blocks --seed 0 --budget-seconds 600`
- layout intent: honoured (intent.yaml)
- profile `default-placement-2-layer`
- outcome **PARTIAL** — every candidate failed a hard gate; the board is unchanged

| engine | rank | eligible | hpwl_mm | courtyard_overlaps | congestion | outside | legalized | routed | runtime_s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| placer-kicad-tools-physics | 1 | false | 732.7 | 43 | 3 | 1 | 6 | - | 81.9 |
| placer-pyplacer | 2 | false | 856.2 | 32 | 74 | 1 | 0 | - | 93.0 |
| placer-fixed | 3 | false | 816.1 | 29 | 18 | 1 | 0 | - | 0.0 |
| placer-reuse-pack | 4 | false | 639.8 | 28 | 3 | 1 | 0 | - | 0.1 |

No `placed.kicad_pcb`: no candidate passed the gates, so nothing was applied and `after.png` still shows the bootstrap grid. `ranking.json` and `place.log` hold why.

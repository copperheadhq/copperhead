# 2026-09-16-connector-edges

- commit `9597b5f`
- `copperhead pcb place --mode race --blocks --seed 0 --budget-seconds 600`
- layout intent: none
- profile `default-placement-2-layer`
- outcome **PASS** — placer-reuse-pack selected: placer-reuse-pack: routability 95%, HPWL 635.7 mm, weighted score 0.000, on the Pareto frontier

| engine | rank | eligible | hpwl_mm | courtyard_overlaps | congestion | outside | legalized | routed | runtime_s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| placer-reuse-pack | 1 | true | 635.7 | 0 | 2 | 0 | 0 | 95.5% | 0.4 |
| placer-kicad-tools-physics | 2 | false | 1123.5 | 231 | 266 | 0 | 24 | - | 324.4 |
| placer-pyplacer | 3 | false | 1157.2 | 4 | 110 | 0 | 4 | - | 96.8 |
| placer-fixed | 4 | false | 1088.8 | 5 | 250 | 0 | 0 | - | 0.0 |

Files: `placed.kicad_pcb` (the board that was applied), `before.png` / `after.png`, `ranking.json`, `place.log`.

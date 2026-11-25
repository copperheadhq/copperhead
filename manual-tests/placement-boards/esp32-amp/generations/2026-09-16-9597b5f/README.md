# 2026-09-16-9597b5f

- commit `9597b5f`
- `copperhead pcb place --mode race --blocks --seed 0 --budget-seconds 600`
- layout intent: none
- profile `default-placement-2-layer`
- outcome **PASS** — placer-reuse-pack selected: placer-reuse-pack: routability 95%, HPWL 596.3 mm, weighted score 0.000, on the Pareto frontier

| engine | rank | eligible | hpwl_mm | courtyard_overlaps | congestion | outside | legalized | routed | runtime_s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| placer-reuse-pack | 1 | true | 596.3 | 0 | 4 | 0 | 0 | 95.5% | 0.4 |
| placer-kicad-tools-physics | 2 | false | 1129.1 | 265 | 311 | 0 | 24 | - | 315.6 |
| placer-pyplacer | 3 | false | 1099.8 | 9 | 69 | 0 | 3 | - | 93.4 |
| placer-fixed | 4 | false | 1081.7 | 4 | 241 | 0 | 0 | - | 0.0 |

Files: `placed.kicad_pcb` (the board that was applied), `before.png` / `after.png`, `ranking.json`, `place.log`.

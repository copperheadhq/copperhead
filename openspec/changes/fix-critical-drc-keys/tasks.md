## 1. Profiles

- [ ] 1.1 `hole_to_hole` replaces `hole_near_hole` in `jlcpcb-2layer.json`, `jlcpcb-4layer.json`, `jlcpcb-6layer.json` and `profiles/index.ts`.

## 2. Checker

- [ ] 2.1 `kicad-drc.ts` counts profile-critical keys over violations and warnings alike; test covers a critical key arriving at warning severity.
- [ ] 2.2 `kicad-drc.ts` reports `drc_placement_critical_count` over the placement-stage list; test.

## 3. Probe

- [ ] 3.1 `routabilityProbe` reports `routability_drc_critical` beside `routability_drc_errors`; test.

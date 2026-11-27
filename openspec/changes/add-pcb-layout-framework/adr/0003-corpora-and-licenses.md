# ADR 0003: Corpora and licenses

**Status:** Accepted (2026-09-06)
**RFC:** 11 §4.2, §13.2, §17, Appendix C.1, Appendix C.2 item 7

## Evidence

**PCBench** (`PCBench/PCBench` at `dec3be7`, repository license MIT): 1 183 boards under `PCBs/<author>_<name>/{raw,processed}.kicad_pcb` with `metadata.json` (the README's "164" is stale). Per-board `licenses` metadata: 605 boards carry none, 108 MIT (dict form) plus 34 MIT (list form), 105 GPL-3.0 plus 33 "GNU", 93 "Other", 28 Apache-2.0, 19 empty. Layers: 1 052 two-layer, 126 four-layer. File formats: 651 KiCad 4, 377 KiCad 5 (`20171130`), 88 KiCad 3, small numbers of 6, 7, and 8-era files.

Processing on the reference machine: the permissively licensed two-layer subset is 181 boards; `kicad-cli pcb upgrade --force` (in place; the command has no `--output`) loaded 177 of them and failed on 4 KiCad 4 files. A full `kicad-cli pcb drc` sweep of the 177 took 375 s and found 39 boards with zero error-severity violations under KiCad 10's default rules; the dominant errors elsewhere were `clearance` (3 081), `solder_mask_bridge` (2 844), `track_width` (2 144), `copper_edge_clearance` (935), `courtyards_overlap` (346), `annular_width` (289), `pth_inside_courtyard` (242): mostly a decade-old design meeting 2026 defaults. 32 of the 39 clean boards have fewer than 50 footprints. The sweep is committed as `bench/corpora/pcbench-drc-sweep.json`.

**PCBWorld**: NC license over software and outputs (ADR 0001). **Cypress** (NVlabs): not yet torn down; its cases are VLSI-style placement instances and its license is unverified, so it is deferred rather than decided. **FreeRouting**: GPL-3.0 jar, user-installed. **pyplacer**: BSD-3-Clause, stdlib plus numpy. **kicad-tools**: MIT. **KiCad footprint libraries**: CC-BY-SA-4.0 with the KiCad library exception that lets boards use them without inheriting the license.

## Decision

1. **PCBench is the real-board corpus** for tracks B and C, restricted to boards that (a) carry a recorded permissive license (MIT, BSD, Apache-2.0, Unlicense, CC0), (b) are two-layer, (c) upgrade with `kicad-cli pcb upgrade`, and (d) pass KiCad 10 DRC with zero errors after upgrade. That pool is 39 boards today. Boards with no recorded license are excluded even though the repository is MIT, because the metadata is the only license evidence for the individual designs.
2. **The qualification suite** is 20 of the 32 clean boards under 50 footprints, chosen across the size range, listed by id in `bench/suites/pcbench-qual.json`. The corpus is never committed; `bench/corpora/pcbench.sh` clones at the pinned commit into `bench/var/corpora/` and upgrades the suite's boards. Track B strips copper from the human board (segments, vias, arcs; zones preserved per RFC §6.6) and routes; the human board is the calibration baseline (RFC §13.4).
3. **Engine license policy** (RFC §17): GPL engines (FreeRouting, PCBWorld-Engine) run out of process on user-installed binaries and are never bundled; MIT/BSD engines (kicad-tools, pyplacer) may be vendored where the ADR says so; NC-licensed software is not used in any form. The manifest `license` field is validated as an SPDX identifier and the runner enforces `executionMode !== 'library'` for copyleft licenses.
4. **Golden microboards** use the installed KiCad footprint libraries under the library exception, with attribution in `bench/golden/README.md`.
5. Cypress is deferred to Phase 3 with its own record.

## Consequences

- The RFC's "50 qualification boards, then the full corpus" for track B becomes 20 now and at most 39 without relaxing the DRC-clean criterion; relaxing it (for example ignoring `solder_mask_bridge` and silk errors as noise) is a separate decision for Phase 2, to be argued from the sweep data.
- The four KiCad 4 boards `kicad-cli` cannot load are dropped, not repaired.

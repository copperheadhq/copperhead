# Decision records for add-pcb-layout-framework

One file per decision RFC 11 leaves to the implementation (its Appendix C.2 and the §3.8 standing rule: before any new algorithm, record which §4.1 neighbour was evaluated and why it was not adopted or wrapped). Each record carries the evidence it rests on, gathered on 5 September 2026 on the reference machine (KiCad 10.0.4, Node 24, Python 3.10 and 3.14), so a later reader can tell a verified fact from a default.

| ADR | Decision | RFC item |
| --- | --- | --- |
| [0001](0001-pcbworld.md) | PCBWorld: adopt the protocol and metric definitions, import no code, no outputs, no datasets | §4.2, Appendix C.2 item 7 |
| [0002](0002-kicad-tools.md) | kicad-tools: wrap `kct route`, `kct placement optimize`, `kct optimize-placement`, `kct check` out of process; vendor its manufacturer rule data | §4.2, Appendix C.2 item 8 |
| [0003](0003-corpora-and-licenses.md) | PCBench (MIT) is the real-board corpus, filtered to permissively licensed, two-layer, DRC-clean boards; engine license and packaging rules | §4.2, §17, Appendix C.2 item 7 |
| [0004](0004-kicad-version.md) | Pin KiCad 10 | §6.4, Appendix C.2 item 4 |
| [0005](0005-geometry-and-contracts.md) | TypeScript geometry on `polygon-clipping`; JSON Schema contracts from the TypeScript types; file-based process protocol | Appendix C.2 items 1 to 3 |
| [0006](0006-critical-drc-and-profile.md) | Critical DRC is membership in the profile's list; `jlcpcb-2layer` vendored from kicad-tools | §10.5, Appendix C.2 items 5 and 6 |
| [0007](0007-bench-home.md) | The benchmark lives in this repository under `bench/` (**superseded by 0012**) | Appendix C.2 item 10 |
| [0008](0008-engine-roster.md) | The v1 engine roster and each wrapper's invocation, from live runs | §8.2, §9.2 |
| [0009](0009-phase-2-checkpoint.md) | Phase 2 checkpoint: ship the routing harness in `create`/`check` first, then Phase 3 | §13.5, §14.2, Appendix B |
| [0010](0010-more-routers.md) | TopoR, OrthoRoute, topola: OrthoRoute wrapped (inner layers only, `minLayers: 4`), TopoR not wrappable, topola waits on a toolchain | §3.8, §4.1, §8.2, §9.2 |
| [0011](0011-multilayer.md) | Up to six copper layers: stack from names, through vias only, profiles by count, layer-aware engines and scoring (`add-multilayer-layout`) | §6, §7, §9.5, B.8 |
| [0012](0012-bench-split.md) | The benchmark moves to the copperbench repository; the engine toolchain and the microboard fixtures stay | Appendix C.2 item 10; RFC 15 |
| [0013](0013-connector-edges.md) | A connector's edge is derived from its block's signal-flow region when no intent file states one | §7.1, §7.3, §8.5 |

Status values: Proposed, Accepted, Superseded. The first nine were accepted by the change owner on 2026-09-06; 0009 records the Phase 2 checkpoint decision (routing ships in `create`/`check` before Phase 3). 0010 (2026-09-07) records the routers evaluated after B4.

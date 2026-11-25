# ADR 0004: Pin KiCad 10

**Status:** Accepted (2026-09-06)
**RFC:** 11 §6.4, Appendix C.2 item 4

## Evidence

KiCad 10.0.4 is installed on the reference machine and in CI (`ppa:kicad/kicad-10.0-releases`). Its `kicad-cli pcb drc` offers `--refill-zones`, `--save-board`, `--schematic-parity`, `--all-track-errors`, and per-severity filters, and `kicad-cli pcb upgrade --force` rewrites boards from KiCad 3 through 9 in place (ADR 0003: 177 of 181 legacy boards). The read-only reader already handles board files from `20240108` (KiCad 8). pyplacer targets KiCad 9's `20241229` format and parsed a KiCad 10 board unchanged in the live run.

## Evidence added during Phase 1

- `kicad-cli` 10.0.4 saves boards as file version **20260206**, and that format has **no net table**: pads, segments, arcs, vias, and zones carry `(net "name")` by name. Boards written by KiCad 8 and 9 (and by copperhead's own scaffold) keep the `(net N "name")` table with codes on every object. The reader accepts both dialects and records which one the file uses (`source.netDialect`); the exporter emits copper in the source's dialect.
- The project file's `rule_severities` are the designer's own settings: StickHub sets `courtyards_overlap` and `missing_courtyard` to ignore and its connectors' courtyards overlap by 0.8 mm. The geometry and pre-flight checkers honour these severities (RFC 11 §7.5), so a real board a designer signed off on does not fail the harness on a rule they switched off.
- pcbnew's `GetLayerName` returns the user's layer name (`top_cu` on ecc83) while every record in the file uses the canonical name; the IR keeps canonical ids and carries the user name beside them.

Two format facts found while building the adapter (6 September 2026): KiCad 10.0.4 *writes* board version `20260206` (the installed demos carry `20250907`; `kicad-cli pcb drc --save-board` on a `20240108` board produced `20260206`), and that format has **no net table**: every pad, segment, arc, via, and zone carries `(net "name")` and there are no net codes. KiCad 8 and 9 files carry `(net N "name")` records and `(net N)` on objects. The reader accepts both dialects and records which one the source uses; export emits copper in the source's dialect.

## Decision

Pin major 10. Import accepts `(version …)` from `20240108` through `20261231` (KiCad 10.0.4 writes `20260206`); older files are upgraded with `kicad-cli pcb upgrade --force` on a copy before import; a newer major returns `UNSUPPORTED`. `doctor` reports a version mismatch through the existing `kicadCheck`. The adapter's tests run on 10.0.x only.

## Consequences

KiCad 9 users are supported for reading, not guaranteed for writing; exported boards carry the version the project declares, so a 9-era project stays loadable in 9 as long as no 10-only construct is emitted (none are in v1).

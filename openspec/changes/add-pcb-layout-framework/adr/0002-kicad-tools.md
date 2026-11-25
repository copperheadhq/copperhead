# ADR 0002: kicad-tools

**Status:** Accepted (2026-09-06)
**RFC:** 11 §4.2, §9.2, §8.2, §10.2, Appendix C.2 item 8

## Context

RFC 11 names kicad-tools four times: adopt its Python DRC and fabrication rule sets, wrap its A* router and placers, and do not adopt its MCP server. The teardown of `rjwalters/kicad-tools` at `cfc166b` (version 0.20.0, MIT, 5 September 2026) corrected the command surface the RFC and the implementation spec assumed.

## Evidence

- `pip install kicad-tools` on Python 3.10 installs `kct` with about seventy subcommands. `shapely` is a core dependency; extras add `rtree` (incremental DRC), `cmaes` (placement), `markitdown`/`pdfplumber`/`PyMuPDF` (datasheets).
- **`kct drc <report>` parses an existing DRC report** (JSON or `.rpt`) with `--mfr` rule checks on top. The pure-Python checker is **`kct check <pcb> --format json --mfr jlcpcb [--refill-zones] [--errors-only] [--strict-connectivity]`**; `--refill-zones` shells out to `kicad-cli pcb drc --refill-zones --save-board`. Its JSON carries `summary` (errors, warnings, infos, rules_checked) and `violations[]` with `rule_id`, `type`, `severity`, `message`, `location`, `layer`, `actual_value`, `required_value`, `items`, `nets`, `waived`. On the ecc83 demo it reported 6 errors and 672 warnings; the errors were `connectivity` findings on nets KiCad's own DRC considers connected through zone fills, so its connectivity rule is a supplementary signal, never the authority (RFC §10.2).
- **`kct route <pcb> -o <out>`** is a command-line autorouter over `.kicad_pcb` files with strategies `basic`, `negotiated`, `monte-carlo`, `evolutionary`, options for nets, regions, preserving existing copper, trace width, clearance, via geometry, timeouts, layer count, and manufacturer tiers, and an optional native C++ backend. Live run on ecc83 with copper stripped (15 footprints, 20 connections): `--strategy negotiated --timeout 300 --skip-drc` completed in 18 s, routed 19 of 20 connections, 65 segments, 3 vias, and KiCad 10 DRC reported zero error-severity violations. `kct route-auto` routes single nets with strategy selection.
- **Placement is two commands.** `kct placement optimize <pcb> --strategy force-directed|evolutionary|hybrid` (force-directed is the "physics simulation" the RFC calls `placer-kicad-tools-physics`), with `--fixed`, `--cluster`, `--constraints`, `--keepout`, `--edge-detect`, `--thermal`, `--routing-aware`, `--check-routability`, `--format json`. `kct optimize-placement <pcb> --strategy cmaes` needs the `placement` extra, seeds from force-directed, random, or current, accepts a weights JSON, a voltage map for creepage-aware domains, a time budget, and warm-starts from the current layout.
- **Manufacturer rules** are data: `manufacturers/data/<mfr>.yaml` (JLCPCB 2-layer 1 oz: min trace and clearance 0.127 mm, via drill 0.3, via diameter 0.6, annular ring 0.15, copper-to-edge 0.3, hole-to-edge 0.5, silk 0.15 mm / 1.0 mm, mask dam 0.1; last verified 2026-01-16, sourced from JLCPCB's capabilities page) plus generated `manufacturers/rules/<mfr>-<layers>layer-<oz>oz.kicad_dru` files, plus `jlcpcb_rotations.yaml` (pick-and-place rotation corrections). `kct mfr rules|export-dru|apply-rules` operate on them.
- Also present and relevant later: `kct zones` and `kct stitch` (pour and stitching-via generation, v1.1 material), `kct creepage`, `kct board-metrics` (aggregates its own project outputs, not a general metric tool), `kct datasheet`, `kct decisions`, and an MCP server.

## Decision

1. **Wrap, do not vendor, the engines**: `router-kicad-tools` drives `kct route` (strategy as a job parameter; `router-kicad-tools-astar` in the RFC is this wrapper with `--strategy basic`), `placer-kicad-tools-physics` drives `kct placement optimize --strategy force-directed`, `placer-kicad-tools-evolutionary` the same command with `--strategy evolutionary`, and `placer-kicad-tools-cmaes` drives `kct optimize-placement`. All run `executionMode: process` through the file protocol with the board exported by our adapter and re-imported afterwards; no Python is imported into the Node runtime. `requires.binaries: ["kct"]`, `requires.python: ">=3.10"`; the manifest pins `kicad-tools==0.20.0` and the wrapper refuses other majors.
2. **`kct check` is the kicad-tools DRC checker plugin**, invoked with `--format json --mfr <profile.kicadToolsMfr>` and never `--refill-zones` (the adapter refills through `kicad-cli` itself so the board on disk is not mutated twice). Its `connectivity` findings map to `quality.kct.connectivity` (warning), never to `conn.*`; every other rule maps to `drc.kct.<rule_id>` at the severity it reports, advisory beside KiCad's authoritative result.
3. **Vendor the rule data**: `manufacturers/data/jlcpcb.yaml` (the `2layer_1oz` block) and `rules/jlcpcb-2layer-1oz.kicad_dru` are copied into `src/pcb/verify/profiles/` with the upstream commit recorded (ADR 0006); the rotation corrections are vendored for the position-file export in the fab package. Both are data files under MIT with attribution kept.
4. **Do not adopt** the MCP server, the LLM reasoning module, the datasheet tools, or `board-metrics`: copperhead has its own tool layer, intent compiler, datasheet cache, and metrics.
5. The parsers are not vendored: the read-only sexp reader already exists and never serializes, which kicad-tools' writer does.

## Consequences

- The implementation spec's `engines/kicad-tools/route.py` and `place.py` wrappers are unnecessary; the adapters call `kct` directly. The spec is corrected.
- Single-maintainer risk (RFC Appendix C.1): pinned to 0.20.0 at `cfc166b`; the wrapper's tests run against that version only.

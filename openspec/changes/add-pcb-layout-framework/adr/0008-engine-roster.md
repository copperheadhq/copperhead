# ADR 0008: The v1 engine roster

**Status:** Accepted (2026-09-06)
**RFC:** 11 §8.2, §9.2, §3.8

Each wrapper below names the §4.1 neighbour it wraps and the live evidence from the reference machine (5 September 2026). Nothing in this roster is a copperhead-authored production engine; the two reference engines are `harnessOnly`.

## Routers

- **router-freerouting**: `freerouting/freerouting` 2.4.1 (GPL-3.0), `java -jar freerouting.jar -de <dsn> -do <ses> -mp <passes>`; needs a JRE 25 (2.2.4, the jar the KiCad plugin installs, needs 21). Routed the ecc83 demo's DSN in 9 s with zero unrouted and zero violations by its own check. DSN dialect and SES scale verified against KiCad's exporter and pcbnew (implementation spec §6.6).
- **router-kicad-tools**: `kct route` 0.20.0 (MIT), strategies `basic|negotiated|monte-carlo|evolutionary`; ecc83 stripped board routed 19/20 connections DRC-clean in 18 s (ADR 0002). `router-kicad-tools-astar` in the RFC is this wrapper with `--strategy basic`.
- **router-reference**: grid Lee/A*, `harnessOnly`, exists so CI has a deterministic router without external binaries.
- **router-orthoroute**: wrapped on 2026-09-07 through its documented ORP/ORS files in CPU-only headless mode; routes on inner layers only, so `minLayers: 4` keeps it off every two-layer board (ADR 0010). TopoR cannot be wrapped (Windows GUI, no CLI); topola waits on a Rust toolchain.
- Deferred: `router-pcbworld-pns` (ADR 0001).

## Placers

- **placer-fixed**: identity; the control.
- **placer-pyplacer**: `ajokela/pyplacer` at `34baa02` (BSD-3-Clause), `python3 run.py in.kicad_pcb out.kicad_pcb --seed N --iterations N --cooling C`, needs numpy. Its parser targets KiCad 9 (`20241229`) and read a KiCad 10 board. Live run on ecc83 (`--iterations 300`, 11 s): placed all movable parts but KiCad DRC found 16 `courtyards_overlap` and 10 `pth_inside_courtyard` errors, so its output is a candidate the placement gates reject unless repaired. *Phase 3, golden `completion` through the wrapper (vendored under `vendor/pyplacer` with two patches: `--fixed`, and a zero-initial-cost guard; fed the net-code dialect because its parser reads pad nets as `(net N "name")`):* a legal candidate in 11 s, no overlaps, routability probe 100 % with 0 DRC errors, HPWL 146.4 mm against the control's 145.8 mm, so the fixed control still wins the ranking. Fixed parts are refdes prefixes `J` and `H` (`kicad_pcb.py:45`); the vendored copy gets a `--fixed <refs>` argument so `lockedComponentIds` are honoured. `export_dsn.py` in the same repository is a two-line pcbnew call and is not used.
- **placer-kicad-tools-physics** / **-evolutionary**: `kct placement optimize --strategy force-directed|evolutionary` with `--fixed`, `--constraints`, `--keepout`, `--edge-detect`, `--thermal`, `--routing-aware`, `--format json`. *Run live in Phase 3 (kicad-tools 0.20.0, golden `completion`, KiCad 10 board handed over in the net-code dialect):* force-directed reports success in 14 s but moves every movable part ~100 mm outside the 36 × 26 mm outline and rotates them (HPWL 788 mm against 146 mm as placed); the same happens with the outline drawn as `gr_line`s instead of a `gr_rect`, so it is not the outline primitive. The harness gates reject it (`geom.outside-board` ×5, `geom.courtyard-overlap` ×3). Evolutionary exits 1 upstream (`'EvolutionaryPlacementOptimizer' object has no attribute 'total_wire_length'`). Both wrappers stay registered and fail closed; neither is a usable placer at this version, and the B2 report says so.
- **placer-kicad-tools-cmaes**: `kct optimize-placement --strategy cmaes` (needs the `placement` extra), warm start from `current`. Not yet run live.
- **placer-layout-reuse**: anchor transforms over reference blocks (RFC §8.6); copperhead-authored but not an optimiser: it copies, so it is exempt from §3.8's rule as a data operation.
- **placer-anchors** and **placer-attach**: deterministic rule stages of the staged plan (RFC §8.5), placing only what a constraint already fixes; exempt for the same reason.
- **placer-reference**: the shelf pack from `board.ts`, `harnessOnly`.

## Checkers

- KiCad DRC through `kicad-cli pcb drc --refill-zones --save-board --format json` (authority for board rules); `kct check --format json --mfr` as the supplementary DRC (ADR 0002); kicad-happy not yet torn down (Phase 1); copperhead geometry, connectivity, intent, return-path, and pre-flight checkers built.

## Consequences

The implementation spec's §6.6 and §6.7 are corrected to this roster; the RFC's engine names are kept and mapped here.

# Routing engines evaluated for #252

The board pipeline emits Specctra DSN and reads SES back
(`src/kicad/layout/dsn.ts`), and also emits a full `.kicad_pcb`
(`src/kicad/board.ts`). Both formats are on the table: a candidate engine either
speaks DSN/SES (the Freerouting ecosystem) or consumes the emitted `.kicad_pcb`
directly.

This file records what was **actually executed** in this environment (KiCad 9.0.9,
Temurin JRE 25, no Rust toolchain) against the `complex_hierarchy` reference
design (68 parts, 50 nets, all through-hole, golden `.kicad_pcb` in
`/usr/share/kicad/demos/complex_hierarchy/`) — not what a README claims. A router
is listed as "executed" only where a binary actually ran and a routed output was
produced; "investigated" means the repo/docs were examined but it could not be
run here, with the concrete reason.

Reproduce everything with:

```bash
# the comparison harness: DSN once, then each engine, DRC on each import
COPPERHEAD_FREEROUTING_JAR=/path/to/freerouting.jar \
COPPERHEAD_FREEROUTE_BIN=/path/to/freeroute \
  npm run route:compare                 # → manual-tests/runs/router-compare/
```

## Results on `complex_hierarchy` (68 parts, 50 nets, 2 signal layers)

Golden reference: 365 tracks, 0 vias, 0 DRC violations, 0 unrouted, board
100.7 × 80.0 mm. "Hard DRC" counts error-severity violations excluding the
ratsnest, via the same `kicad-cli pcb drc` on every board.

| Router | Version | Executed | I/O | Routed | Unrouted | Hard DRC | Tracks | Vias | Runtime |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Freerouting** (jar) | 2.3.0 | yes | DSN→SES | 50/50 | 0 | **25** | 752 | 32 | ~100 s |
| KiCadRoutingTools | 0.21.3 | yes | PCB→PCB | 50/50 | 0 | **0** | 1305 | 190 | ~58 s |
| kicad-tools | 0.20.0 | yes¹ | PCB→PCB | 45/47² | — | — | — | — | >5 min |
| freeroute grid | 2026.7.14 | yes | DSN→SES | 50/50 | 0 | 1255 | 2697 | 102 | 23 s |
| freeroute exact | 2026.7.14 | yes | DSN→SES | — | 40 | 646 | 1975 | 203 | 18.5 s |
| freeroute room | 2026.7.14 | yes³ | DSN→SES | — | — | — | — | — | >15 min |

¹ kicad-tools' C++ backend gave up on the denser nets ("C++ A* open set
exhausted") and fell back to pure-Python A*; it was still routing after 5 min and
was stopped. ² 45 of its 47 net-set at the stop point. ³ the `room` engine did
not finish a 68-part board in 15 minutes and was stopped.

The two numbers that matter are **Routed** (did it finish every net) and
**Hard DRC** (did the finished board pass). By that pair:

- **KiCadRoutingTools** is the strongest here: 50/50 and 0 violations — but it
  does so by self-selecting finer geometry (0.127 mm tracks, ~0.158 mm clearance,
  190 vias) and writing a `.kicad_pro` that *lowers the clearance rule and demotes
  `solder_mask_bridge` to "ignore"*. The 0 above is measured against KiCad's
  default board rules, i.e. *before* applying its own relaxation.
- **Freerouting** finishes every net but leaves 25 violations (6 shorts,
  7 clearance, 12 solder-mask bridges) — the known cost of routing a
  connectivity-blind placement on a dense through-hole board.
- **freeroute** (the Python port) is dramatically worse on dense boards: its grid
  engine emits imprecise, grid-quantised geometry (397 same-layer crossings,
  511 clearance, 191 hole-clearance), and its "exact" engine drops 40 nets rather
  than violate clearance.

## The one real interop bug this surfaced: SES coordinate units

Freerouting's `SesWriter` writes session coordinates in Specctra *resolution
units* — 0.1 µm each for `(resolution um 10)`, i.e. 10 000 units/mm. The `freeroute`
port echoes raw micrometre coordinates back unchanged (1 000 units/mm) **while
still declaring `(resolution um 10)`**. Both files look identical in their
header and differ by an exact factor of 10 in every coordinate; reading a
`freeroute` session with the Freerouting scale shrinks the board 10×.

`parseSes` now accepts `{ resolutionUnits: false }` for a raw-unit writer, and
the default (Freerouting) convention is unchanged. See
`src/kicad/layout/dsn.ts` and the pinned test in `test/layout-dsn.test.ts`.

## Investigated but NOT executable here

| Project | License | Why not run |
| --- | --- | --- |
| [topola](https://github.com/mikwielgus/topola) | MIT | The only other serious headless DSN→SES autorouter (`topola-cli`), but Rust-only with no prebuilt binary and no crates.io publish; no `cargo` here. Revisit if a Rust toolchain is added. |
| [routing-rs](https://github.com/dilawar/routing-rs) | AGPL-3.0 | Rust-only and self-declared non-functional ("vibecoded, doesn't work yet"). |
| [ACORN](https://github.com/danboyne/ACORN) | MIT | Build fails (`png.h: No such file or directory`; needs `libgd-dev`/`libpng-dev`, no sudo). Even built, it consumes/emits its own text+HTML format, not DSN/SES/`.kicad_pcb`. |
| [qautorouter](https://github.com/udif/qautorouter-svn) | GPL-3.0 | Qt4 GUI app, abandoned; Qt4 unavailable on Ubuntu 22.04. |

Not routers at all: `pcbflow` (layout scripting), FD-Autoplacer (placement),
`kicad-freerouting-plugin-alt` (DSN export only, still calls Freerouting), TopoR /
Specctra / Electra / DeepPCB (proprietary or cloud).

## Why Freerouting stays the default

For the DSN/SES path it is the only mature, licence-compatible engine, and it
beats its own Python port by an order of magnitude on this board (25 vs 1255
violations). KiCadRoutingTools is genuinely better at raw completion/cleanliness
but is a `.kicad_pcb`-in/`.kicad_pcb`-out engine that quietly relaxes the DRC
floor to get there, which cuts against copperhead's verification-gated-out
contract (`AC-2.1`): copperhead will not import a board that only passes because
the router rewrote the rules. It remains a strong candidate to revisit as a
second, opt-in engine once its rule-relaxation is made explicit and opt-out.

## Known limitations

- **The ceiling is placement, not the router.** copperhead places on a
  deterministic, connectivity-blind grid (`src/kicad/layout/placement.ts`). A
  decoupling cap can land far from its IC, so nets span the whole board and the
  router congests. Testing a squarer aspect ratio (1.5× vs 2.5× `sqrt(area)`) did
  *not* reduce violations (66 vs 25 in back-to-back runs), so the wider row is
  retained; fixing this properly is connectivity-aware placement (#141), out of
  scope here.
- **Freerouting's multi-threaded optimisation is known to introduce clearance
  violations** (it prints this warning itself and recommends `-mt 1`). `-mt 1`
  did not change the result on this board (identical internal score), so the
  adapter is left unchanged; it is a lever to pull if a board shows
  optimisation-only violations.
- **Connectivity vs golden is name-based and low (24/50)** on every engine,
  because the flattened netlist uses hierarchical net names the 2022-vintage
  golden does not. It is a net-naming artifact, not a routing defect; the
  load-bearing metric is `unrouted == 0`.
- Freerouting is non-deterministic (multi-threaded); violation counts can vary
  run-to-run.

## What remains

1. **Connectivity-aware placement (#141)** — the single largest quality lever;
   the router comparison above shows no router rescues a blind grid placement.
2. **A KiCad-native engine adapter** behind the same `RoutingEngine` boundary,
   gated so it can never relax the DRC floor copperhead verifies against.
3. **THT-hole awareness in the DSN padstacks** — neither Freerouting nor
   `freeroute` models the drill, so tracks can crowd holes (freeroute's 191
   hole-clearance violations come from this).

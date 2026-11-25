# pyplacer

A simulated-annealing PCB component placer for KiCad boards, written in Python.

pyplacer reads a `.kicad_pcb` file with unplaced (or partially placed) components,
runs simulated annealing to minimize a cost function combining wirelength, component
overlap, out-of-bounds, and routing-channel congestion, and writes the placed
components back to a new `.kicad_pcb` file ready for routing with
[Freerouting](https://github.com/freerouting/freerouting) or any other autorouter.

## Honest Expectations

This is a weekend project, written specifically to produce an open-source baseline
to benchmark against [Quilter.ai](https://quilter.ai) on a dense 161-net Arduino
Giga shield. On that board:

- **Quilter**: 99.4% routed (1 net unrouted)
- **pyplacer** (best of 64 seeds): 93.8% routed (10 nets unrouted)
- **pyplacer** (typical): 87–90% routed

So: pyplacer produces placements that are usable as a starting point for further
hand work, but not usable as-is for fabrication on a dense board. On less-dense
boards, it should perform better.

The full benchmark write-up is at
[tinycomputers.io](https://tinycomputers.io/posts/what-a-commercial-pcb-placer-does-that-my-open-source-one-cant.html).

## Why Does This Exist

There is no well-known open-source PCB placement tool. Freerouting is excellent at
routing but does not do placement. KiCad, Eagle, and pcb-rnd have no real placement
automation. Commercial options exist (Altium, Cadence, Quilter) but are expensive
or closed. pyplacer is a minimal, readable, BSD-licensed starting point for anyone
who wants to experiment with automated placement or build a better one.

## Installation

No dependencies beyond the Python standard library. Tested on Python 3.10+.

```bash
git clone https://github.com/ajokela/pyplacer
cd pyplacer
```

## Usage

```bash
python3 run.py input.kicad_pcb output.kicad_pcb
```

Full options:

```
python3 run.py input.kicad_pcb output.kicad_pcb \
    --iterations 5000 \      # moves per temperature plateau
    --cooling 0.96 \         # cooling rate (0 < a < 1)
    --t-final-ratio 1e-4 \   # stop when T/T_init < this
    --seed 42                # random seed
```

The input should be a KiCad 9 `.kicad_pcb` file. Components with reference
designators starting with `J` (connectors) or `H` (mounting holes) are treated as
fixed; everything else is free to move. Edit `placer.py` if your fixed-component
naming convention differs.

### Typical workflow with Freerouting

```bash
# 1. Place components
python3 run.py board.kicad_pcb board_placed.kicad_pcb --seed 42

# 2. Export DSN from KiCad, or from Python via pcbnew:
#    KiCad -> File -> Export -> Specctra DSN
# 3. Route
java -jar freerouting.jar -de board.dsn -do board.ses

# 4. Import the .ses back into KiCad
```

### Seed sweeps

SA is stochastic — different seeds give different local minima. For a dense board,
it is worth running several seeds in parallel and picking the best:

```bash
for seed in 1 2 3 4 5 6 7 8; do
    python3 run.py board.kicad_pcb out_s$seed.kicad_pcb --seed $seed &
done
wait
```

Route each result and compare unrouted counts.

## How It Works

### Cost function

The SA cost function in `placer.py` is a weighted sum:

```python
W_HPWL           = 1.0      # half-perimeter wire length
W_OVERLAP_HARD   = 1000.0   # components actually overlapping
W_OVERLAP_SOFT   = 50.0     # components within KEEPOUT_SOFT of each other
W_OUT_OF_BOUNDS  = 200.0    # components outside the board outline
W_CONGESTION     = 40.0     # L-shape probe-routed congestion map
W_PAD_EXIT       = 5.0      # penalty for nets exiting a pad on its "dead" side
```

All weights are tunable constants at the top of `placer.py`. The congestion term
divides the board into 2mm cells, probes L-shaped candidate routes for each net,
and penalizes cells that accumulate more than `CELL_CAPACITY` traces.

### Heuristic seed placement

Before SA starts, `initial_place.py` places each movable component at a sensible
starting position:

1. For each active IC (U1, U2, ...), determine its two "dominant" connectors (the
   fixed connectors it has the most signal-net connections to)
2. Place the IC at the midpoint between those two connectors, with special
   handling for clusters of ICs sharing the same connector pair
3. Place satellite passives (bypass caps, pull-down resistors) next to their
   associated IC using small fixed offsets

SA then refines from this seed. The heuristic is tuned for the Arduino Giga shield
layout pattern (ICs between two connectors) but generalizes reasonably.

### Moves

At each SA step, one of three moves is proposed:

- **Shift**: move one component a Gaussian-random distance (scale proportional to
  temperature)
- **Swap**: exchange positions of two movable components
- **Reseat**: pick up a component and drop it at a random position on the board

Rotation moves are currently disabled — they were tried and consistently made
results worse without further cost-function work to support them.

## Known Limitations

Things I know about but have not fixed. Pull requests welcome on any of these.

1. **Connector-edge congestion**: the coarse-grid congestion term does not
   recognize the specific failure mode of too many signals trying to enter the
   same side of a dense connector. On the benchmark board, 15 of 17 chronically-
   unrouted nets all try to enter the J9 2x18 header through the same 10mm
   routing channel. A term that counts incoming pin density at each connector's
   edge and penalizes above a threshold would likely close most of the gap to
   Quilter.

2. **No rotation moves**: adding rotation to the move proposal would let SA
   unclog congested pad orientations. The existing code has the dead-simple
   version disabled because it tends to propose rotations that hurt more than
   help — needs rotation-aware cost function support.

3. **Single-sided only**: everything placed on the top copper layer. Bottom-side
   placement would require reasoning about front/back BGA-like pin mirroring
   that the parser does not currently do.

4. **KiCad 9 specific**: the writer rewrites `(at X Y [rot])` tokens in place
   using byte-offsets into the source file. It targets the KiCad 9 format
   (version 20241229). Older KiCad versions may require small parser tweaks.

5. **No multi-candidate output**: `run.py` produces one result per invocation.
   For seed sweeps, run it multiple times from a shell loop.

6. **No DRC awareness**: the cost function approximates routing channel capacity
   but has no notion of track width, clearance, via sizes, or differential pairs.
   Tight-rules boards will see worse relative performance.

## Files

| File | Purpose |
|------|---------|
| `run.py` | CLI entry point |
| `placer.py` | SA main loop and cost function |
| `kicad_pcb.py` | Minimal KiCad 9 PCB parser and writer |
| `initial_place.py` | Heuristic seed placement |
| `congestion.py` | L-shape probe congestion map |
| `export_dsn.py` | Stub (uses pcbnew, macOS only; optional) |
| `patch_pcb_rnd.py` | Optional bridge to pcb-rnd for fabrication |

The whole package is about 1,400 lines of Python. It is meant to be read and
modified, not used as a black box.

## License

BSD 3-Clause — see `LICENSE`.

## Acknowledgments

Built while benchmarking [Quilter.ai](https://quilter.ai) for a review partnership
on [tinycomputers.io](https://tinycomputers.io). Thanks to Quilter for tolerating
a comparison that did not favor them on every axis.

The benchmark board design is the
[GigaShield](https://github.com/ajokela/giga-shield), a level-shifter shield
between an Arduino Giga R1 (3.3V) and a RetroShield Z80 (5V).

#!/usr/bin/env python3
"""Run SA placement on a KiCad PCB.

Usage: python3 run.py <input.kicad_pcb> <output.kicad_pcb> [options]
"""
from __future__ import annotations
import argparse
import sys

# Force line-buffered stdout so progress shows up in real time when piped to a file
# (default Python block-buffering would hide the plateau-by-plateau progress lines).
sys.stdout.reconfigure(line_buffering=True)

from kicad_pcb import parse_board, write_board
from placer import place, PlacerConfig


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="input .kicad_pcb")
    ap.add_argument("output", help="output .kicad_pcb")
    ap.add_argument("--iterations", type=int, default=2000,
                    help="moves per temperature plateau (default 2000)")
    ap.add_argument("--cooling", type=float, default=0.95,
                    help="cooling rate 0<a<1 (default 0.95)")
    ap.add_argument("--t-init", type=float, default=None,
                    help="initial temperature (default: auto)")
    ap.add_argument("--t-final-ratio", type=float, default=1e-4,
                    help="stop when T/T_init < this (default 1e-4)")
    ap.add_argument("--seed", type=int, default=0,
                    help="random seed")
    ap.add_argument("--seed-pcb", default=None,
                    help="copy positions from this .kicad_pcb as starting placement "
                         "(skips heuristic initial placement)")
    ap.add_argument("--skip-sa", action="store_true",
                    help="write the seed placement without running SA")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--fixed", default=None,
                    help="comma-separated refdes to keep fixed (copperhead patch; default: J* and H*)")
    args = ap.parse_args()
    if args.fixed is not None:
        import kicad_pcb as _kp
        _kp.FIXED_REFS = set(r for r in args.fixed.split(",") if r)

    board = parse_board(args.input)
    print(f"loaded {args.input}")
    print(f"  {len(board.footprints)} footprints "
          f"({sum(1 for f in board.footprints if f.fixed)} fixed, "
          f"{sum(1 for f in board.footprints if not f.fixed)} movable)")
    print(f"  {len(board.nets_with_pads())} nets with >=2 pads")
    print(f"  board outline: {board.outline}")
    print()

    cfg = PlacerConfig(
        iterations_per_plateau=args.iterations,
        cooling=args.cooling,
        t_init=args.t_init,
        t_final_ratio=args.t_final_ratio,
        seed=args.seed,
        seed_pcb=args.seed_pcb,
        skip_sa=args.skip_sa,
    )
    stats = place(board, cfg)

    write_board(board, args.output)
    print(f"\nwrote {args.output}")
    return 0


if __name__ == '__main__':
    sys.exit(main())

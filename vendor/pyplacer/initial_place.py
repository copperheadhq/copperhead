"""Heuristic initial placement for pyplacer.

Core idea: each level shifter has 8 A-side pins going to one Giga header and
8 B-side pins going to another. The shifter must be placed in the *gap between*
those two connectors so each side has a short route. Placing the shifter past
one of them (further from the other) forces long wraparound traces.

Algorithm:
  1. For each shifter, inspect its signal pads. Classify each connected fixed
     connector by ref. Pick the top 2 dominant connectors (the ones serving the
     most pins).
  2. Place the shifter at the midpoint between those two connectors, offset
     perpendicular to the line between them by a small amount to leave routing
     space at the shifter edges.
  3. Cluster VCCA/VCCB caps and DIR resistor next to the shifter.

Satellite caps and resistors inherit the shifter's cluster.
"""

from __future__ import annotations
from collections import Counter
from statistics import mean
from typing import Dict, Tuple

from kicad_pcb import Board, Footprint

POWER_NET_NAMES = {'GND', '+3V3', '+5V'}


def _fp_by_ref(board: Board, ref: str) -> Footprint | None:
    for fp in board.footprints:
        if fp.ref == ref:
            return fp
    return None


def _dominant_connectors(board: Board, fp: Footprint) -> list[tuple[str, int]]:
    """Return [(connector_ref, pin_count), ...] sorted by pin_count desc,
    for fixed connectors this footprint has signal-net connections to."""
    nets = board.nets_with_pads()
    hits: Counter[str] = Counter()
    for pad in fp.pads:
        if pad.net <= 0:
            continue
        net_name = board.nets_by_id.get(pad.net, '')
        if net_name in POWER_NET_NAMES:
            continue
        for other_fp, _ in nets.get(pad.net, []):
            if other_fp is fp or not other_fp.fixed:
                continue
            hits[other_fp.ref] += 1
    return hits.most_common()


def _connector_centroid(fp: Footprint) -> Tuple[float, float]:
    """Return the average pad position of a connector footprint."""
    pts = [fp.pad_abs(p) for p in fp.pads]
    return (mean(p[0] for p in pts), mean(p[1] for p in pts))


def _clamp_to_board(board: Board, x: float, y: float,
                    margin: float = 5.0) -> Tuple[float, float]:
    oxmin, oymin, oxmax, oymax = board.outline
    return (max(oxmin + margin, min(x, oxmax - margin)),
            max(oymin + margin, min(y, oymax - margin)))


def _shifter_position(board: Board, fp: Footprint) -> tuple[float, float, str]:
    """Return (x, y, note) for where to place this shifter, based on dominant
    connector analysis. The shifter lands at the midpoint of its two dominant
    connectors, biased slightly toward a routing channel."""
    doms = _dominant_connectors(board, fp)
    # Filter to top-2 with significant pin counts
    signals = [(ref, n) for ref, n in doms if n >= 3]
    oxmin, oymin, oxmax, oymax = board.outline
    if len(signals) < 1:
        # no signal connections to fixed parts — drop in the middle
        return ((oxmin + oxmax) / 2, (oymin + oymax) / 2, 'no connections')
    if len(signals) == 1:
        # only one dominant: place just adjacent to it
        conn = _fp_by_ref(board, signals[0][0])
        if conn is None:
            return ((oxmin + oxmax) / 2, (oymin + oymax) / 2, 'conn missing')
        cx, cy = _connector_centroid(conn)
        # Bias inward from board center
        bx, by = (oxmin + oxmax) / 2, (oymin + oymax) / 2
        dx, dy = bx - cx, by - cy
        import math
        d = math.hypot(dx, dy) or 1.0
        off = 8.0  # mm
        return (cx + dx / d * off, cy + dy / d * off,
                f'adjacent to {signals[0][0]}')

    # Two-plus dominant: midpoint of the top two
    a_ref, a_count = signals[0]
    b_ref, b_count = signals[1]
    conn_a = _fp_by_ref(board, a_ref)
    conn_b = _fp_by_ref(board, b_ref)
    ax, ay = _connector_centroid(conn_a)
    bx, by = _connector_centroid(conn_b)
    mx, my = (ax + bx) / 2, (ay + by) / 2
    return (mx, my, f'midpoint of {a_ref}↔{b_ref}')


def heuristic_initial_placement(board: Board) -> Dict[str, str]:
    """Seed movable components with connectivity-driven positions.

    Returns {ref: reason} for reporting."""
    notes: Dict[str, str] = {}
    outline = board.outline

    # Stage 1: shifters at midpoint of their two dominant connectors.
    # Group shifters by (a_ref, b_ref) pair so we can spread same-midpoint shifters
    # along the connector midline.
    groups: dict[tuple[str, str], list[str]] = {}
    for i in range(1, 11):
        u = _fp_by_ref(board, f'U{i}')
        if u is None or u.fixed:
            continue
        doms = _dominant_connectors(board, u)
        signals = [ref for ref, n in doms if n >= 3]
        if len(signals) < 2:
            key = (signals[0] if signals else '?', '?')
        else:
            key = tuple(sorted([signals[0], signals[1]]))
        groups.setdefault(key, []).append(u.ref)

    for (a_ref, b_ref), refs in groups.items():
        if b_ref == '?':
            # single-connector group: place adjacent
            for ref in refs:
                u = _fp_by_ref(board, ref)
                x, y, reason = _shifter_position(board, u)
                u.x, u.y = _clamp_to_board(board, x, y)
                u.rot = 0
                notes[ref] = reason
            continue
        conn_a = _fp_by_ref(board, a_ref)
        conn_b = _fp_by_ref(board, b_ref)
        ax, ay = _connector_centroid(conn_a)
        bx, by = _connector_centroid(conn_b)
        mx, my = (ax + bx) / 2, (ay + by) / 2
        # If the two connectors span the board vertically (y-gap > 40mm),
        # placing the shifter at the midpoint puts it in the dense center where
        # other shifters' routes compete. Instead, bias toward the NORTH
        # connector (smaller y) and place ~8mm south of it — matches the pattern
        # in manual placements where shifters serving the top and bottom Giga
        # headers are placed near the top edge.
        if abs(ay - by) > 40.0:
            north = (ax, ay) if ay < by else (bx, by)
            my = north[1] + 8.0
            mx = north[0]
        n = len(refs)
        # For 3+ shifters sharing a connector pair, use 2-column layout so each
        # shifter has its own routing channels on both sides. Manual placement does
        # this for the U6-U10 cluster (at x=118 and x=134 between J9 and J10).
        if n >= 3:
            # Two columns at 1/4 and 3/4 of the way from connector a to connector b.
            col_a_x = ax + (bx - ax) * 0.3
            col_a_y = ay + (by - ay) * 0.3
            col_b_x = ax + (bx - ax) * 0.7
            col_b_y = ay + (by - ay) * 0.7
            # Spread along the OTHER axis (perpendicular to a-b)
            # If a-b is mostly horizontal, spread shifters vertically.
            if abs(bx - ax) > abs(by - ay):
                axis = 'y'
            else:
                axis = 'x'
            pitch = 10.0
            for k, ref in enumerate(sorted(refs)):
                col = k % 2  # alternate columns
                row = k // 2  # row index
                cx = col_a_x if col == 0 else col_b_x
                cy = col_a_y if col == 0 else col_b_y
                off = (row - (n - 1) / 4) * pitch
                u = _fp_by_ref(board, ref)
                if axis == 'y':
                    u.x, u.y = _clamp_to_board(board, cx, cy + off)
                else:
                    u.x, u.y = _clamp_to_board(board, cx + off, cy)
                u.rot = 0
                notes[ref] = f'2-col {a_ref}↔{b_ref} col{col} row{row}'
        else:
            # 2 or fewer shifters: spread along midline
            pitch = 10.0
            if abs(ay - by) >= abs(ax - bx):
                for k, ref in enumerate(sorted(refs)):
                    off = (k - (n - 1) / 2) * pitch
                    u = _fp_by_ref(board, ref)
                    u.x, u.y = _clamp_to_board(board, mx + off, my)
                    u.rot = 0
                    notes[ref] = f'midpoint of {a_ref}↔{b_ref} (offset {off:+.1f})'
            else:
                for k, ref in enumerate(sorted(refs)):
                    off = (k - (n - 1) / 2) * pitch
                    u = _fp_by_ref(board, ref)
                    u.x, u.y = _clamp_to_board(board, mx, my + off)
                    u.rot = 0
                    notes[ref] = f'midpoint of {a_ref}↔{b_ref} (offset {off:+.1f})'

    # Stage 2b: de-overlap shifters that landed at the same spot (common when
    # multiple shifters share a dominant connector). Spread horizontally by 12mm
    # pitch along the connector they're attached to.
    shifter_fps = [_fp_by_ref(board, f'U{i}') for i in range(1, 11)]
    shifter_fps = [fp for fp in shifter_fps if fp is not None]
    for _ in range(10):
        moved = False
        for i, a in enumerate(shifter_fps):
            for b in shifter_fps[i + 1:]:
                dx = a.x - b.x
                dy = a.y - b.y
                min_dx, min_dy = 11.0, 5.5
                if abs(dx) < min_dx and abs(dy) < min_dy:
                    # Push apart horizontally (shifters are wide, short)
                    push = (min_dx - abs(dx) + 0.5) / 2
                    if dx >= 0:
                        a.x += push
                        b.x -= push
                    else:
                        a.x -= push
                        b.x += push
                    a.x, a.y = _clamp_to_board(board, a.x, a.y)
                    b.x, b.y = _clamp_to_board(board, b.x, b.y)
                    moved = True
        if not moved:
            break

    # Stage 3: satellite clustering (caps + DIR resistor)
    # Cap numbering: C_{2i-1}=VCCA, C_{2i}=VCCB. R_i = DIR pull-down.
    # Offsets at rot=0 target the shifter pad positions for A/B VCC pads.
    offsets = {
        'vcca': (3.0, -5.0),
        'vccb': (-3.0, -5.0),
        'dir':  (-4.0, 5.0),
    }
    for i in range(1, 11):
        u = _fp_by_ref(board, f'U{i}')
        if u is None:
            continue
        cA = _fp_by_ref(board, f'C{2 * i - 1}')
        cB = _fp_by_ref(board, f'C{2 * i}')
        r = _fp_by_ref(board, f'R{i}')
        if cA and not cA.fixed:
            dx, dy = offsets['vcca']
            cA.x, cA.y = _clamp_to_board(board, u.x + dx, u.y + dy)
            cA.rot = 0
            notes[cA.ref] = f'clustered with {u.ref} (VCCA)'
        if cB and not cB.fixed:
            dx, dy = offsets['vccb']
            cB.x, cB.y = _clamp_to_board(board, u.x + dx, u.y + dy)
            cB.rot = 0
            notes[cB.ref] = f'clustered with {u.ref} (VCCB)'
        if r and not r.fixed:
            dx, dy = offsets['dir']
            r.x, r.y = _clamp_to_board(board, u.x + dx, u.y + dy)
            r.rot = 0
            notes[r.ref] = f'clustered with {u.ref} (DIR)'

    # Stage 4: bulk bypass caps along empty row
    oxmin, oymin, oxmax, oymax = outline
    row_y = (oymin + oymax) / 2
    extra_refs = [f'C{i}' for i in range(21, 30)]
    usable = [_fp_by_ref(board, r) for r in extra_refs]
    usable = [c for c in usable if c is not None and not c.fixed]
    if usable:
        stride = (oxmax - oxmin - 20) / max(1, len(usable))
        for k, c in enumerate(usable):
            c.x, c.y = _clamp_to_board(board, oxmin + 10 + k * stride, row_y)
            c.rot = 0
            notes[c.ref] = 'bulk bypass cap row'

    return notes

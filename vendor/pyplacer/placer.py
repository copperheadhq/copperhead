"""Simulated-annealing PCB placer.

Moves non-fixed components to minimize:
    total HPWL over all nets
  + overlap penalty (bbox+keepout collisions between components)
  + out-of-bounds penalty (components outside the board outline)
  + congestion penalty (probe-routed density map over the board)

Fixed components (J* and H*) stay where they are.
"""

from __future__ import annotations
import math
import random
import time
from dataclasses import dataclass
from typing import Dict, List, Tuple

from kicad_pcb import Board, Footprint
from congestion import CongestionMap
from initial_place import heuristic_initial_placement


# ------------------------------------------------------------
# Cost function
# ------------------------------------------------------------

# Weights
W_HPWL = 1.0
W_OVERLAP_HARD = 1000.0   # per mm^2 of true bbox-bbox intersection (always bad)
W_OVERLAP_SOFT = 50.0     # per mm^2 of the soft-gradient near-gap penalty
W_OUT_OF_BOUNDS = 200.0
W_CONGESTION = 40.0
W_PAD_EXIT = 5.0          # penalty for nets routing through a pad's dead side
W_ATTACHMENT = 0.0        # disabled
W_DISPLACE = 0.0          # disabled — SA refinement beats heuristic
# Soft keepout: no penalty beyond this gap; quadratic ramp as gap → 0.
# Unlike a hard 4mm keepout (which penalizes the tight clusters the manual layout
# uses), this allows 1-2mm gaps cheaply while still pushing the placer away from
# face-to-face contact.
KEEPOUT_SOFT = 2.0        # mm
# Congestion capacity: 8 instead of 4 — a realistic 2-layer board has roughly
# twice the throughput of my single-layer model.
CELL_SIZE = 2.0
CELL_CAPACITY = 8.0
POWER_NET_NAMES = {'GND', '+3V3', '+5V'}
W_POWER_NET = 0.2


def hpwl_for_net(pad_positions: List[Tuple[float, float]]) -> float:
    """Half-perimeter wire length — the standard placer cost metric."""
    if len(pad_positions) < 2:
        return 0.0
    xs = [p[0] for p in pad_positions]
    ys = [p[1] for p in pad_positions]
    return (max(xs) - min(xs)) + (max(ys) - min(ys))


def bbox_overlap_penalty(a: Tuple[float, float, float, float],
                         b: Tuple[float, float, float, float]) -> Tuple[float, float]:
    """Returns (hard_overlap_area, soft_near_gap_penalty).

    hard_overlap_area: true intersection area when bodies actually overlap.
    soft_near_gap_penalty: quadratic on (KEEPOUT_SOFT − gap) for face-to-face edges,
    0 when gap ≥ KEEPOUT_SOFT. Only triggered when boxes overlap on one axis and
    are close on the other."""
    dx = min(a[2], b[2]) - max(a[0], b[0])  # positive if x-overlap, else = -gap_x
    dy = min(a[3], b[3]) - max(a[1], b[1])
    if dx > 0 and dy > 0:
        return (dx * dy, 0.0)
    # Face-to-face: one axis overlaps, other is a gap
    if dx > 0 >= dy:
        gap = -dy
        edge_length = dx
    elif dy > 0 >= dx:
        gap = -dx
        edge_length = dy
    else:
        return (0.0, 0.0)  # corner-to-corner; ignore
    if gap >= KEEPOUT_SOFT:
        return (0.0, 0.0)
    deficit = KEEPOUT_SOFT - gap
    return (0.0, deficit * deficit * edge_length)


def out_of_bounds_area(bbox: Tuple[float, float, float, float],
                       outline: Tuple[float, float, float, float]) -> float:
    """How much of bbox sticks out of outline (in mm^2). 0 if fully inside."""
    bxmin, bymin, bxmax, bymax = bbox
    oxmin, oymin, oxmax, oymax = outline
    bbox_area = max(0.0, (bxmax - bxmin)) * max(0.0, (bymax - bymin))
    ix = max(0.0, min(bxmax, oxmax) - max(bxmin, oxmin))
    iy = max(0.0, min(bymax, oymax) - max(bymin, oymin))
    inside_area = ix * iy
    return bbox_area - inside_area


def pad_exit_dir(fp: Footprint, pad) -> Tuple[float, float]:
    """World-frame unit-ish exit direction for a pad — the direction a trace naturally
    leaves the pad, perpendicular to the footprint body edge the pad sits on.

    Heuristic: the pad's local (x_local, y_local) from footprint origin; the dominant
    axis is the exit direction. For TSSOP/SOIC packages this correctly gives ±y (rows
    along x-axis) and for 0402/0603 caps it gives ±x (rows along y-axis on short
    components) — either way, the trace leaves in the direction from body center toward
    the pad's nearest body edge."""
    lx, ly = pad.x_local, pad.y_local
    if abs(lx) >= abs(ly):
        local = (1.0 if lx >= 0 else -1.0, 0.0)
    else:
        local = (0.0, 1.0 if ly >= 0 else -1.0)
    return fp.rotate_point(local[0], local[1])


def attachment_cost(shifter_dominants: list) -> float:
    """Disabled — kept for API compatibility. Returns 0."""
    return 0.0


def displacement_cost(shifter_initial: list) -> float:
    """Penalize each shifter's distance from the heuristic's initial position.

    shifter_initial is a list of (fp, ix, iy) tuples (fp is unhashable as dataclass,
    so we use a list rather than dict). The heuristic places shifters at sensible
    header-adjacent rows; SA without this penalty tends to drift shifters into the
    dense middle of the board where HPWL is minimized but routing fails."""
    import math
    cost = 0.0
    slack = 3.0
    for fp, ix, iy in shifter_initial:
        d = math.hypot(fp.x - ix, fp.y - iy)
        if d > slack:
            cost += (d - slack)
    return cost


def pad_exit_cost(board: Board, nets, pad_cache: dict,
                  fp_by_pad: dict, exit_cache: dict) -> float:
    """Penalty when a net's centroid lies behind a pad's exit side (trace would
    have to wrap around the component body). Approximates pin-access blockage."""
    cost = 0.0
    for nid, pairs in nets.items():
        if len(pairs) < 2:
            continue
        positions = [pad_cache[(id(fp), pad.pad_id)] for fp, pad in pairs]
        cx = sum(p[0] for p in positions) / len(positions)
        cy = sum(p[1] for p in positions) / len(positions)
        for fp, pad in pairs:
            px, py = pad_cache[(id(fp), pad.pad_id)]
            ex, ey = exit_cache[(id(fp), pad.pad_id)]
            # Vector from pad toward net centroid
            dx, dy = cx - px, cy - py
            dot = dx * ex + dy * ey
            if dot < 0:
                # Trace wants to head opposite of exit direction — penalize by the
                # distance it has to travel the wrong way.
                cost += -dot
    return cost


def total_cost(board: Board, nets, bboxes: List[Tuple[float, float, float, float]],
               pad_cache: dict, exit_cache: dict, fp_by_pad: dict,
               congestion: CongestionMap,
               shifter_dominants: list | None = None,
               shifter_initial: dict | None = None) -> Tuple[float, float, float, float, float, float]:
    """Return (total, hpwl, overlap_hard+soft, oob, cong, exit)."""
    hpwl = 0.0
    for nid, pairs in nets.items():
        net_name = board.nets_by_id.get(nid, '')
        weight = W_POWER_NET if net_name in POWER_NET_NAMES else 1.0
        positions = [pad_cache[(id(fp), pad.pad_id)] for fp, pad in pairs]
        hpwl += weight * hpwl_for_net(positions)

    hard = 0.0
    soft = 0.0
    n = len(bboxes)
    for i in range(n):
        for j in range(i + 1, n):
            h, s = bbox_overlap_penalty(bboxes[i], bboxes[j])
            hard += h
            soft += s

    oob = 0.0
    for bb in bboxes:
        oob += out_of_bounds_area(bb, board.outline)

    cong = congestion.cost(CELL_CAPACITY)
    ex = pad_exit_cost(board, nets, pad_cache, fp_by_pad, exit_cache)
    att = attachment_cost(shifter_dominants) if shifter_dominants else 0.0
    disp = displacement_cost(shifter_initial) if shifter_initial else 0.0

    total = (W_HPWL * hpwl
             + W_OVERLAP_HARD * hard
             + W_OVERLAP_SOFT * soft
             + W_OUT_OF_BOUNDS * oob
             + W_CONGESTION * cong
             + W_PAD_EXIT * ex
             + W_ATTACHMENT * att
             + W_DISPLACE * disp)
    return total, hpwl, hard + soft, oob, cong, ex


# ------------------------------------------------------------
# Geometry helpers
# ------------------------------------------------------------

def refresh_footprint_cache(fp: Footprint, pad_cache: dict, exit_cache: dict,
                            bboxes: List[Tuple[float, float, float, float]],
                            bbox_index: dict) -> None:
    """Recompute cached pad positions, exit directions, and bbox for one footprint."""
    for pad in fp.pads:
        pad_cache[(id(fp), pad.pad_id)] = fp.pad_abs(pad)
        exit_cache[(id(fp), pad.pad_id)] = pad_exit_dir(fp, pad)
    bboxes[bbox_index[id(fp)]] = fp.bbox_abs()


# ------------------------------------------------------------
# Moves
# ------------------------------------------------------------

@dataclass
class MoveRecord:
    """Reversible record of a move — captures the state needed to undo."""
    fps: List[Footprint]
    old_states: List[Tuple[float, float, float]]  # (x, y, rot) before


def propose_move(board: Board, movable: List[Footprint],
                 temperature_scale: float, rng: random.Random) -> MoveRecord:
    """Make a random modification. Returns a record that can undo it."""
    oxmin, oymin, oxmax, oymax = board.outline

    # No rotation moves: the known-good manual layout uses rot=0 for every shifter;
    # letting SA explore rotations lets it flip A-side / B-side of TSSOP packages the
    # wrong way, which the pad-exit penalty can detect but not reliably undo.
    choice = rng.random()
    if choice < 0.85 or len(movable) < 2:
        fp = rng.choice(movable)
        rec = MoveRecord(fps=[fp], old_states=[(fp.x, fp.y, fp.rot)])
        span = max(2.0, min(oxmax - oxmin, oymax - oymin) * temperature_scale)
        if rng.random() < 0.1:
            fp.x = rng.uniform(oxmin, oxmax)
            fp.y = rng.uniform(oymin, oymax)
        else:
            fp.x += rng.uniform(-span, span)
            fp.y += rng.uniform(-span, span)
        return rec

    # Swap two components of the same reference prefix (e.g. two caps, two shifters).
    # Swapping a cap with a shifter would typically uncluster and worsen cost.
    a = rng.choice(movable)
    same_type = [fp for fp in movable if fp is not a and fp.ref[0] == a.ref[0]]
    if not same_type:
        return MoveRecord(fps=[a], old_states=[(a.x, a.y, a.rot)])
    b = rng.choice(same_type)
    rec = MoveRecord(fps=[a, b], old_states=[(a.x, a.y, a.rot), (b.x, b.y, b.rot)])
    a.x, a.y, b.x, b.y = b.x, b.y, a.x, a.y
    return rec


def undo_move(rec: MoveRecord) -> None:
    for fp, (x, y, rot) in zip(rec.fps, rec.old_states):
        fp.x, fp.y, fp.rot = x, y, rot


# ------------------------------------------------------------
# Main SA loop
# ------------------------------------------------------------

@dataclass
class PlacerConfig:
    iterations_per_plateau: int = 2000
    cooling: float = 0.95
    t_final_ratio: float = 1e-4   # stop when T / T_init < this
    t_init: float | None = None   # None => auto from initial cost delta samples
    seed: int = 0
    progress_every: int = 5        # print progress every N plateaus
    seed_pcb: str | None = None    # if set, copy positions from this PCB instead of heuristic init
    skip_sa: bool = False          # if True, write placement without running SA


def place(board: Board, cfg: PlacerConfig = PlacerConfig()) -> dict:
    """Run SA placement in-place on board. Returns stats."""
    rng = random.Random(cfg.seed)

    movable = [fp for fp in board.footprints if not fp.fixed]
    if not movable:
        raise ValueError("no movable footprints")

    if cfg.seed_pcb:
        from kicad_pcb import parse_board as _parse
        ref_board = _parse(cfg.seed_pcb)
        ref_by_ref = {fp.ref: fp for fp in ref_board.footprints}
        copied = 0
        for fp in board.footprints:
            if fp.fixed:
                continue
            src = ref_by_ref.get(fp.ref)
            if src is None:
                continue
            fp.x, fp.y, fp.rot = src.x, src.y, src.rot
            copied += 1
        print(f"seeded {copied} movable footprints from {cfg.seed_pcb}")
    else:
        # Heuristic initial placement: shifters at centroid of their fixed-connector pads,
        # caps/resistors clustered adjacent to their shifter. Gives SA a much better
        # starting point than pure random.
        notes = heuristic_initial_placement(board)
        print(f"heuristic initial placement: seeded {len(notes)} movable footprints")
        for i in range(1, 11):
            u = next((fp for fp in board.footprints if fp.ref == f'U{i}'), None)
            if u:
                print(f"  {u.ref}: {notes.get(u.ref, '?')}  pos=({u.x:.1f}, {u.y:.1f})")

    # Build caches
    bboxes = [fp.bbox_abs() for fp in board.footprints]
    bbox_index = {id(fp): i for i, fp in enumerate(board.footprints)}
    pad_cache = {}
    exit_cache = {}
    fp_by_pad = {}
    for fp in board.footprints:
        for pad in fp.pads:
            key = (id(fp), pad.pad_id)
            pad_cache[key] = fp.pad_abs(pad)
            exit_cache[key] = pad_exit_dir(fp, pad)
            fp_by_pad[key] = fp

    nets = board.nets_with_pads()

    # Precompute each shifter's dominant-connector positions (for attachment cost).
    # These don't change during SA since connectors are fixed.
    from collections import Counter
    shifter_dominants: list = []
    for fp in board.footprints:
        if fp.fixed or not fp.ref.startswith('U'):
            continue
        hits: Counter = Counter()
        for pad in fp.pads:
            if pad.net <= 0:
                continue
            name = board.nets_by_id.get(pad.net, '')
            if name in POWER_NET_NAMES:
                continue
            for other_fp, _ in nets.get(pad.net, []):
                if other_fp is fp or not other_fp.fixed:
                    continue
                hits[other_fp.ref] += 1
        targets = []
        for conn_ref, n in hits.most_common(2):
            if n < 3:
                continue
            conn_fp = next((f for f in board.footprints if f.ref == conn_ref), None)
            if conn_fp is None:
                continue
            pts = [conn_fp.pad_abs(p) for p in conn_fp.pads]
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            targets.append((cx, cy))
        shifter_dominants.append((fp, targets))

    # Snapshot each shifter's initial (heuristic) position for the displacement cost.
    shifter_initial: list = [(fp, fp.x, fp.y) for fp, _ in shifter_dominants]

    # Reverse index: for each footprint, which nets does it belong to?
    fp_nets: Dict[int, set] = {id(fp): set() for fp in board.footprints}
    for nid, pairs in nets.items():
        for fp, pad in pairs:
            fp_nets[id(fp)].add(nid)

    # Build the congestion map
    congestion = CongestionMap(board.outline, cell_size=CELL_SIZE)
    for nid, pairs in nets.items():
        positions = [pad_cache[(id(fp), pad.pad_id)] for fp, pad in pairs]
        congestion.add_net(nid, positions)

    def net_positions(nid):
        return [pad_cache[(id(fp), pad.pad_id)] for fp, pad in nets[nid]]

    def apply_move(rec):
        """Recompute caches and congestion for the moved footprints.
        Returns the set of affected net_ids and a snapshot of their old contribs."""
        affected = set()
        for fp in rec.fps:
            affected |= fp_nets[id(fp)]
        # Snapshot current contribs for these nets
        snapshot = {nid: congestion.net_contribs.get(nid) for nid in affected}
        # Refresh footprint caches
        for fp in rec.fps:
            refresh_footprint_cache(fp, pad_cache, exit_cache, bboxes, bbox_index)
        # Update congestion for affected nets
        for nid in affected:
            congestion.update_net(nid, net_positions(nid))
        return affected, snapshot

    def revert_move(rec, affected, snapshot):
        """Undo a move and restore the congestion snapshot for affected nets."""
        undo_move(rec)
        for fp in rec.fps:
            refresh_footprint_cache(fp, pad_cache, exit_cache, bboxes, bbox_index)
        # Restore snapshot: subtract current contribution, add back old
        for nid in affected:
            current = congestion.net_contribs.get(nid)
            if current is not None:
                for cy, cx, w in current.cells:
                    congestion.grid[cy, cx] -= w
                del congestion.net_contribs[nid]
            old = snapshot[nid]
            if old is not None:
                for cy, cx, w in old.cells:
                    congestion.grid[cy, cx] += w
                congestion.net_contribs[nid] = old

    cost, hpwl, overlap, oob, cong, exitc = total_cost(
        board, nets, bboxes, pad_cache, exit_cache, fp_by_pad, congestion, shifter_dominants, shifter_initial)
    initial_cost = cost

    # Auto-choose initial temperature: sample a few random moves and pick T so that
    # median bad-move acceptance is around 0.8
    if cfg.t_init is None:
        deltas = []
        for _ in range(100):
            rec = propose_move(board, movable, 0.3, rng)
            affected, snapshot = apply_move(rec)
            new_cost, *_ = total_cost(
                board, nets, bboxes, pad_cache, exit_cache, fp_by_pad, congestion, shifter_dominants, shifter_initial)
            d = new_cost - cost
            revert_move(rec, affected, snapshot)
            if d > 0:
                deltas.append(d)
        if deltas:
            median = sorted(deltas)[len(deltas) // 2]
            t_init = median / math.log(1.0 / 0.8)
        else:
            t_init = 1000.0
    else:
        t_init = cfg.t_init
    t_final = t_init * cfg.t_final_ratio

    print(f"initial cost: {initial_cost:.1f}  "
          f"(hpwl={hpwl:.1f}, overlap={overlap:.1f}, oob={oob:.1f}, "
          f"cong={cong:.1f}, exit={exitc:.1f})")
    print(f"congestion grid: {congestion.nx}x{congestion.ny} cells @ {CELL_SIZE}mm, "
          f"capacity={CELL_CAPACITY}")

    if cfg.skip_sa:
        print("skip_sa: writing seed placement without SA")
        return {
            'initial_cost': initial_cost,
            'final_cost': initial_cost,
            'final_hpwl': hpwl,
            'final_overlap': overlap,
            'final_oob': oob,
            'final_congestion': cong,
            'max_density': congestion.max_density(),
            'over_capacity_cells': congestion.over_capacity_cells(CELL_CAPACITY),
            'moves': 0, 'accepted': 0, 'elapsed_seconds': 0.0,
        }

    print(f"T_init: {t_init:.1f}  T_final: {t_final:.5f}  cooling: {cfg.cooling}")

    # Main loop
    t = t_init
    plateau = 0
    total_moves = 0
    accepted = 0
    best_cost = cost
    best_state = [(fp.x, fp.y, fp.rot) for fp in board.footprints]
    start_time = time.time()

    while t > t_final:
        plateau_accepted = 0
        plateau_attempted = 0
        temp_scale = 0.1 + 0.9 * (t / t_init)  # normalized [0.1, 1.0]

        for _ in range(cfg.iterations_per_plateau):
            rec = propose_move(board, movable, temp_scale, rng)
            affected, snapshot = apply_move(rec)
            new_cost, *_ = total_cost(
                board, nets, bboxes, pad_cache, exit_cache, fp_by_pad, congestion, shifter_dominants, shifter_initial)
            delta = new_cost - cost

            if delta <= 0 or rng.random() < math.exp(-delta / t):
                cost = new_cost
                plateau_accepted += 1
                if cost < best_cost:
                    best_cost = cost
                    best_state = [(fp.x, fp.y, fp.rot) for fp in board.footprints]
            else:
                revert_move(rec, affected, snapshot)
            plateau_attempted += 1
            total_moves += 1

        accepted += plateau_accepted
        if plateau % cfg.progress_every == 0:
            _, hpwl, overlap, oob, cong, exitc = total_cost(
                board, nets, bboxes, pad_cache, exit_cache, fp_by_pad, congestion, shifter_dominants, shifter_initial)
            acc_rate = plateau_accepted / plateau_attempted
            max_dens = congestion.max_density()
            over_cells = congestion.over_capacity_cells(CELL_CAPACITY)
            print(f"  plateau {plateau:3d}  T={t:8.2f}  cost={cost:10.1f}  "
                  f"hpwl={hpwl:7.1f}  overlap={overlap:6.1f}  cong={cong:6.1f}  "
                  f"exit={exitc:5.1f}  maxdens={max_dens:4.1f}  over={over_cells:3d}  "
                  f"acc={acc_rate:.2f}")

        t *= cfg.cooling
        plateau += 1

    # Restore best state and rebuild congestion from scratch (cheap)
    for fp, (x, y, rot) in zip(board.footprints, best_state):
        fp.x, fp.y, fp.rot = x, y, rot
    for fp in board.footprints:
        refresh_footprint_cache(fp, pad_cache, exit_cache, bboxes, bbox_index)
    congestion = CongestionMap(board.outline, cell_size=CELL_SIZE)
    for nid, pairs in nets.items():
        congestion.add_net(nid, net_positions(nid))

    _, hpwl, overlap, oob, cong, exitc = total_cost(
        board, nets, bboxes, pad_cache, exit_cache, fp_by_pad, congestion, shifter_dominants, shifter_initial)

    elapsed = time.time() - start_time
    print(f"\nfinished in {elapsed:.1f}s  ({total_moves} moves, {accepted} accepted)")
    print(f"final cost: {best_cost:.1f}  "
          f"(hpwl={hpwl:.1f}, overlap={overlap:.1f}, oob={oob:.1f}, "
          f"cong={cong:.1f}, exit={exitc:.1f})")
    print(f"max cell density: {congestion.max_density():.1f}  "
          f"over-capacity cells: {congestion.over_capacity_cells(CELL_CAPACITY)}")
    # copperhead patch: a zero initial cost (nothing to optimise) is not an error
    print(f"improvement: {((initial_cost - best_cost) / initial_cost * 100) if initial_cost else 0.0:.1f}%")

    return {
        'initial_cost': initial_cost,
        'final_cost': best_cost,
        'final_hpwl': hpwl,
        'final_overlap': overlap,
        'final_oob': oob,
        'final_congestion': cong,
        'max_density': congestion.max_density(),
        'over_capacity_cells': congestion.over_capacity_cells(CELL_CAPACITY),
        'moves': total_moves,
        'accepted': accepted,
        'elapsed_seconds': elapsed,
    }

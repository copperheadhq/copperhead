"""Congestion map / probe routing for density-aware placement.

Approach:
  - Divide board into a grid of cell_size × cell_size cells (default 2mm).
  - For each net, build a minimum spanning tree over its pin positions (Prim's with
    rectilinear distance). Each tree edge is probe-routed as an L-shape: one horizontal
    segment at y1, one vertical segment at x2. Each cell crossed by a segment gets +1
    density contribution.
  - MST + L-shape approximates the rectilinear Steiner minimal tree (the standard cheap
    model for post-placement wire estimation). Concentrates density on likely routing
    paths rather than spreading it over the net's bounding box.
  - Cost = sum over cells of max(0, density - capacity)². Quadratic so small overages
    are mild; heavy congestion strongly penalized.

Incremental updates:
  - Each net's contribution is stored as a list of (cy, cx, amount) cell deltas.
  - When a component moves, the affected nets' contributions are subtracted, recomputed
    with new pin positions, and added back. ~100-500 cell updates per move; fast.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np


@dataclass
class NetContribution:
    """Cached density delta for one net: list of (cy, cx, amount) tuples."""
    cells: List[Tuple[int, int, float]]


class CongestionMap:
    def __init__(self, outline: Tuple[float, float, float, float], cell_size: float = 2.0):
        self.xmin, self.ymin, xmax, ymax = outline
        self.cell_size = cell_size
        self.nx = max(1, int(np.ceil((xmax - self.xmin) / cell_size)))
        self.ny = max(1, int(np.ceil((ymax - self.ymin) / cell_size)))
        self.grid = np.zeros((self.ny, self.nx), dtype=np.float64)
        self.net_contribs: Dict[int, NetContribution] = {}

    def _cell(self, x: float, y: float) -> Tuple[int, int]:
        cx = int((x - self.xmin) / self.cell_size)
        cy = int((y - self.ymin) / self.cell_size)
        return (max(0, min(cx, self.nx - 1)),
                max(0, min(cy, self.ny - 1)))

    def _l_shape_cells(self, x1: float, y1: float,
                       x2: float, y2: float) -> List[Tuple[int, int]]:
        """Cells along an L-shape from (x1,y1) to (x2,y2): horizontal at y1, vertical at x2."""
        cx1, cy1 = self._cell(x1, y1)
        cx2, cy2 = self._cell(x2, y2)
        cells = []
        # Horizontal segment at row cy1
        for cx in range(min(cx1, cx2), max(cx1, cx2) + 1):
            cells.append((cy1, cx))
        # Vertical segment at column cx2 (skip corner already added)
        y_lo, y_hi = min(cy1, cy2), max(cy1, cy2)
        for cy in range(y_lo, y_hi + 1):
            if cy != cy1:
                cells.append((cy, cx2))
        return cells

    def _mst_edges(self, positions: List[Tuple[float, float]]) -> List[Tuple[int, int]]:
        """Prim's MST over positions using rectilinear distance.
        Returns list of (i, j) index pairs for MST edges."""
        n = len(positions)
        if n < 2:
            return []
        in_tree = [False] * n
        in_tree[0] = True
        best_dist = [float('inf')] * n
        best_parent = [0] * n
        # init distances from node 0
        x0, y0 = positions[0]
        for j in range(1, n):
            xj, yj = positions[j]
            best_dist[j] = abs(x0 - xj) + abs(y0 - yj)
            best_parent[j] = 0
        edges = []
        for _ in range(n - 1):
            # pick minimum distance vertex not in tree
            u = -1
            best = float('inf')
            for j in range(n):
                if not in_tree[j] and best_dist[j] < best:
                    best = best_dist[j]
                    u = j
            if u < 0:
                break
            in_tree[u] = True
            edges.append((best_parent[u], u))
            # update distances for remaining vertices
            xu, yu = positions[u]
            for j in range(n):
                if not in_tree[j]:
                    xj, yj = positions[j]
                    d = abs(xu - xj) + abs(yu - yj)
                    if d < best_dist[j]:
                        best_dist[j] = d
                        best_parent[j] = u
        return edges

    def _compute_contrib(self, pin_positions: List[Tuple[float, float]]) -> NetContribution:
        """Compute MST+L-shape cell contributions for one net."""
        edges = self._mst_edges(pin_positions)
        cell_counter: Dict[Tuple[int, int], float] = {}
        for i, j in edges:
            x1, y1 = pin_positions[i]
            x2, y2 = pin_positions[j]
            for cell in self._l_shape_cells(x1, y1, x2, y2):
                cell_counter[cell] = cell_counter.get(cell, 0.0) + 1.0
        return NetContribution(cells=[(cy, cx, w) for (cy, cx), w in cell_counter.items()])

    def add_net(self, net_id: int, pin_positions: List[Tuple[float, float]]) -> None:
        if len(pin_positions) < 2:
            return
        contrib = self._compute_contrib(pin_positions)
        for cy, cx, w in contrib.cells:
            self.grid[cy, cx] += w
        self.net_contribs[net_id] = contrib

    def update_net(self, net_id: int, pin_positions: List[Tuple[float, float]]) -> None:
        """Subtract old contribution and add new — incremental update for SA."""
        old = self.net_contribs.get(net_id)
        if old is not None:
            for cy, cx, w in old.cells:
                self.grid[cy, cx] -= w
        if len(pin_positions) < 2:
            self.net_contribs.pop(net_id, None)
            return
        new = self._compute_contrib(pin_positions)
        for cy, cx, w in new.cells:
            self.grid[cy, cx] += w
        self.net_contribs[net_id] = new

    def cost(self, capacity: float = 8.0) -> float:
        """Quadratic over-capacity penalty.

        Capacity represents how many trace-units a cell can hold. A 2mm cell at
        0.3mm clearance + 0.254mm trace fits ~2 traces per direction per layer.
        4 signal layers × 2 directions × 2 traces = 16 absolute max, but most cells
        have some pad area too. 8 is a realistic usable capacity."""
        excess = np.maximum(self.grid - capacity, 0.0)
        return float(np.sum(excess * excess))

    def max_density(self) -> float:
        return float(self.grid.max())

    def over_capacity_cells(self, capacity: float = 8.0) -> int:
        return int(np.sum(self.grid > capacity))

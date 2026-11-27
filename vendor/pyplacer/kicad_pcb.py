"""KiCad PCB file parser and writer for pyplacer.

We don't need a full S-expression parser — we only need to:
- Extract footprint positions, pad layouts, net assignments, and bounding boxes
- Extract board outline from Edge.Cuts
- Rewrite footprint top-level (at X Y [rot]) in place, leaving everything else untouched

Targets KiCad 9 format (version 20241229).
"""

from __future__ import annotations
from dataclasses import dataclass, field
import math
import re
from typing import List, Dict, Tuple


# copperhead patch: set by run.py --fixed; None means upstream's prefix rule
FIXED_REFS = None

@dataclass
class Pad:
    pad_id: str
    x_local: float   # relative to footprint origin (pre-rotation)
    y_local: float
    net: int         # 0 = no net / unconnected
    size: Tuple[float, float]


@dataclass
class Footprint:
    ref: str
    lib_name: str
    x: float
    y: float
    rot: float                      # 0 / 90 / 180 / 270
    pads: List[Pad]
    bbox_local: Tuple[float, float, float, float]  # (xmin, ymin, xmax, ymax) pre-rotation
    # Byte-range into original source so the writer can substitute position
    at_start: int = 0               # offset of "(at ..." in source
    at_end: int = 0                 # offset of matching close paren + 1
    fp_start: int = 0
    fp_end: int = 0

    @property
    def fixed(self) -> bool:
        # copperhead patch: the caller names the fixed refdes (--fixed); upstream's
        # rule (connectors J* and mounting holes H* stay put) applies only when
        # no list was given.
        if FIXED_REFS is not None:
            return self.ref in FIXED_REFS
        return self.ref.startswith('J') or self.ref.startswith('H')

    def rotate_point(self, lx: float, ly: float) -> Tuple[float, float]:
        """Rotate a local (lx, ly) by self.rot degrees around origin, matching KiCad's
        PCB frame transform. KiCad stores rotation in degrees; positive values rotate
        clockwise as rendered on the PCB (because KiCad's PCB Y axis grows downward
        while footprint library Y grows upward).

        Verified empirically against `FOOTPRINT.GetBoundingBox()`:
          - rot=90  maps library (0, +L) to PCB (+L, 0)
          - rot=-90 maps library (0, +L) to PCB (-L, 0)
          - rot=180 maps library (x, y) to PCB (-x, -y)"""
        rot = self.rot % 360
        if rot == 0:
            return (lx, ly)
        if rot == 90:
            return (ly, -lx)
        if rot == 180:
            return (-lx, -ly)
        if rot == 270:
            return (-ly, lx)
        # Fallback for non-orthogonal angles: counter-clockwise math rotation with Y flip
        rad = math.radians(rot)
        c, s = math.cos(rad), math.sin(rad)
        return (c * lx + s * ly, -s * lx + c * ly)

    def pad_abs(self, pad: Pad) -> Tuple[float, float]:
        rx, ry = self.rotate_point(pad.x_local, pad.y_local)
        return (self.x + rx, self.y + ry)

    def bbox_abs(self) -> Tuple[float, float, float, float]:
        """Axis-aligned bbox after rotation and translation."""
        xmin, ymin, xmax, ymax = self.bbox_local
        corners = [(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)]
        rotated = [self.rotate_point(cx, cy) for cx, cy in corners]
        xs = [self.x + rx for rx, _ in rotated]
        ys = [self.y + ry for _, ry in rotated]
        return (min(xs), min(ys), max(xs), max(ys))


@dataclass
class Board:
    source: str                     # full original text
    footprints: List[Footprint]
    nets_by_id: Dict[int, str]
    outline: Tuple[float, float, float, float]  # (xmin, ymin, xmax, ymax) from Edge.Cuts

    @property
    def nets_by_name(self) -> Dict[str, int]:
        return {v: k for k, v in self.nets_by_id.items()}

    def nets_with_pads(self) -> Dict[int, List[Tuple[Footprint, Pad]]]:
        """Return {net_id: [(footprint, pad), ...]} for nets with >= 2 pads.
        Power nets (GND, +3V3, +5V) are usually large — they dominate the cost and
        can be filtered or down-weighted elsewhere."""
        result: Dict[int, List[Tuple[Footprint, Pad]]] = {}
        for fp in self.footprints:
            for pad in fp.pads:
                if pad.net <= 0:
                    continue
                result.setdefault(pad.net, []).append((fp, pad))
        return {nid: pairs for nid, pairs in result.items() if len(pairs) >= 2}


def _find_matching_paren(s: str, start: int) -> int:
    """Given s[start] == '(', return index one past the matching close paren."""
    assert s[start] == '('
    depth = 0
    i = start
    while i < len(s):
        c = s[i]
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError(f"unmatched paren starting at {start}")


def _parse_at(content: str, start: int, end: int) -> Tuple[float, float, float, int, int]:
    """Find the first top-level (at X Y [rot]) in a footprint block at content[start:end].
    Returns (x, y, rot, at_start, at_end_exclusive)."""
    # Look for (at N N [N]) at one nesting level inside the block.
    # Since the opening (footprint paren is at start, children are at depth 1.
    depth = 0
    i = start
    while i < end:
        c = content[i]
        if c == '(':
            if depth == 1:
                # Check if this is (at
                m = re.match(r'\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\s*\)', content[i:])
                if m:
                    x = float(m.group(1))
                    y = float(m.group(2))
                    rot = float(m.group(3)) if m.group(3) else 0.0
                    return (x, y, rot, i, i + m.end())
            depth += 1
        elif c == ')':
            depth -= 1
        i += 1
    raise ValueError("no top-level (at ...) found in footprint block")


def parse_board(pcb_path: str) -> Board:
    with open(pcb_path) as f:
        content = f.read()

    # ---- Nets ----
    nets_by_id: Dict[int, str] = {}
    for m in re.finditer(r'\(net\s+(\d+)\s+"([^"]*)"\s*\)', content):
        nets_by_id[int(m.group(1))] = m.group(2)

    # ---- Board outline from Edge.Cuts (gr_line / gr_rect) ----
    xs, ys = [], []
    for m in re.finditer(
        r'\(gr_line[^)]*?\(start\s+(-?[\d.]+)\s+(-?[\d.]+)\).*?\(end\s+(-?[\d.]+)\s+(-?[\d.]+)\).*?\(layer\s+"Edge\.Cuts"\)',
        content, re.DOTALL
    ):
        xs.extend([float(m.group(1)), float(m.group(3))])
        ys.extend([float(m.group(2)), float(m.group(4))])
    # Fallback/also catch gr_rect
    for m in re.finditer(
        r'\(gr_rect[^)]*?\(start\s+(-?[\d.]+)\s+(-?[\d.]+)\).*?\(end\s+(-?[\d.]+)\s+(-?[\d.]+)\).*?\(layer\s+"Edge\.Cuts"\)',
        content, re.DOTALL
    ):
        xs.extend([float(m.group(1)), float(m.group(3))])
        ys.extend([float(m.group(2)), float(m.group(4))])
    if not xs:
        raise ValueError("could not find Edge.Cuts geometry to determine board outline")
    outline = (min(xs), min(ys), max(xs), max(ys))

    # ---- Footprints ----
    footprints: List[Footprint] = []
    pos = 0
    while True:
        fp_open = content.find('(footprint ', pos)
        if fp_open < 0:
            break
        fp_close = _find_matching_paren(content, fp_open)
        block = content[fp_open:fp_close]

        # library name
        lib_m = re.match(r'\(footprint\s+"([^"]+)"', block)
        lib_name = lib_m.group(1) if lib_m else ""

        # reference
        ref_m = re.search(r'\(property\s+"Reference"\s+"([^"]+)"', block)
        ref = ref_m.group(1) if ref_m else "?"

        # top-level (at X Y [rot]) — position offset is relative to fp_open
        try:
            x, y, rot, at_rel_start, at_rel_end = _parse_at(content, fp_open, fp_close)
        except ValueError:
            pos = fp_close
            continue

        # Pads: (pad "id" type shape (at lx ly [rot]) ... (net N "name")? ...)
        pads: List[Pad] = []
        pad_coords: List[Tuple[float, float, float, float]] = []  # for bbox
        for pm in re.finditer(
            r'\(pad\s+"([^"]+)"\s+\S+\s+\S+\s*\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+-?[\d.]+)?\s*\)\s*(?:\(size\s+(-?[\d.]+)\s+(-?[\d.]+)\))?',
            block
        ):
            pad_id = pm.group(1)
            lx = float(pm.group(2))
            ly = float(pm.group(3))
            sx = float(pm.group(4)) if pm.group(4) else 1.0
            sy = float(pm.group(5)) if pm.group(5) else 1.0
            # Look for (net N "name") within the enclosing pad paren scope
            pad_start = fp_open + pm.start()
            pad_end = _find_matching_paren(content, pad_start)
            pad_block = content[pad_start:pad_end]
            net_m = re.search(r'\(net\s+(\d+)\s+"[^"]*"\s*\)', pad_block)
            net_id = int(net_m.group(1)) if net_m else 0
            pads.append(Pad(pad_id=pad_id, x_local=lx, y_local=ly, net=net_id, size=(sx, sy)))
            # pad bbox contribution (axis-aligned in local frame)
            pad_coords.append((lx - sx/2, ly - sy/2, lx + sx/2, ly + sy/2))

        if pad_coords:
            bxmin = min(c[0] for c in pad_coords)
            bymin = min(c[1] for c in pad_coords)
            bxmax = max(c[2] for c in pad_coords)
            bymax = max(c[3] for c in pad_coords)
        else:
            bxmin, bymin, bxmax, bymax = -1.0, -1.0, 1.0, 1.0
        bbox_local = (bxmin, bymin, bxmax, bymax)

        footprints.append(Footprint(
            ref=ref,
            lib_name=lib_name,
            x=x, y=y, rot=rot,
            pads=pads,
            bbox_local=bbox_local,
            at_start=at_rel_start,
            at_end=at_rel_end,
            fp_start=fp_open,
            fp_end=fp_close,
        ))
        pos = fp_close

    return Board(source=content, footprints=footprints, nets_by_id=nets_by_id, outline=outline)


def write_board(board: Board, out_path: str) -> None:
    """Write PCB with updated footprint positions. Rewrites only the top-level (at ...)
    of each footprint; everything else passes through untouched."""
    # Collect substitutions sorted by start offset
    subs = []
    for fp in board.footprints:
        if int(fp.rot) == 0:
            new_at = f'(at {fp.x} {fp.y})'
        else:
            new_at = f'(at {fp.x} {fp.y} {fp.rot})'
        subs.append((fp.at_start, fp.at_end, new_at))
    subs.sort(key=lambda s: s[0])

    out = []
    cursor = 0
    for s, e, text in subs:
        out.append(board.source[cursor:s])
        out.append(text)
        cursor = e
    out.append(board.source[cursor:])
    with open(out_path, 'w') as f:
        f.write(''.join(out))


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print("usage: kicad_pcb.py <pcb>", file=sys.stderr)
        sys.exit(1)
    b = parse_board(sys.argv[1])
    print(f"footprints: {len(b.footprints)}")
    print(f"nets:       {len(b.nets_by_id)}")
    print(f"outline:    {b.outline}")
    print()
    print("Sample footprints:")
    for fp in b.footprints[:6]:
        print(f"  {fp.ref:6s} {fp.lib_name}  at ({fp.x:.1f}, {fp.y:.1f}) rot={fp.rot}  "
              f"fixed={fp.fixed}  pads={len(fp.pads)}  bbox={fp.bbox_local}")
    print()
    nets = b.nets_with_pads()
    print(f"Nets with >=2 pads: {len(nets)}")
    # Show largest nets
    by_size = sorted(nets.items(), key=lambda kv: -len(kv[1]))[:5]
    print("Largest nets:")
    for nid, pins in by_size:
        print(f"  net {nid} '{b.nets_by_id.get(nid, '?')}'  {len(pins)} pins")

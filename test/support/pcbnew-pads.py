"""Dump every footprint's pads from a board through KiCad's own pcbnew module.

Oracle for the IR importer (RFC 11 §6, AC-17.2): positions and orientations as
KiCad computes them. Run with the interpreter pcbnew was built for (the system
python3 on Ubuntu) and PYTHONPATH pointing at its dist-packages.

usage: pcbnew-pads.py BOARD.kicad_pcb  -> JSON on stdout
"""
import json, sys
import pcbnew

b = pcbnew.LoadBoard(sys.argv[1])
out = []
for fp in b.GetFootprints():
    p = fp.GetPosition()
    pads = []
    for pad in fp.Pads():
        ap = pad.GetPosition(); sz = pad.GetSize()
        pads.append({'n': pad.GetNumber(), 'x': pcbnew.ToMM(ap.x), 'y': pcbnew.ToMM(ap.y), 'rot': pad.GetOrientationDegrees(),
                     'w': pcbnew.ToMM(sz.x), 'h': pcbnew.ToMM(sz.y), 'net': pad.GetNetname(),
                     'layers': [b.GetLayerName(l) for l in pad.GetLayerSet().CuStack()]})
    out.append({'ref': fp.GetReference(), 'x': pcbnew.ToMM(p.x), 'y': pcbnew.ToMM(p.y), 'rot': fp.GetOrientationDegrees(),
                'side': 'back' if fp.IsFlipped() else 'front', 'pads': pads})
json.dump(out, sys.stdout)

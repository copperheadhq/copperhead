# Microboard fixtures

Eighteen tiny KiCad boards, each built to exercise one behaviour of the PCB
stack: a clean completion case, a deliberate short, an overlap, a part outside
the outline, a keepout, a crystal, decoupling near and far, a four- and a
six-layer stack, and so on. `expected.json` names the diagnostics
`pcb verify` must raise on the board and the status the gates must reach, so a
regression in the importer, the checkers, or the profiles fails a test rather
than quietly changing a number.

These are a **frozen snapshot**. The generator that produces them
(`bench/golden/generate.ts`) and the benchmark suites that run engines over
them live in the [copperbench](https://github.com/copperheadhq/copperbench)
repository, which holds the same boards as its microboard corpus. Changing a
board means changing it there and copying the result here; the two copies
drifting apart shows up as a test failure on whichever side moved.

Only `board.kicad_pcb`, `board.kicad_pro`, `intent.yaml` and `expected.json`
are kept: the benchmark's own bookkeeping is not copperhead's business.

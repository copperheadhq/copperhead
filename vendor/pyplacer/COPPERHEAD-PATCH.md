# pyplacer, vendored

Upstream: github.com/ajokela/pyplacer at `34baa02`, BSD-3-Clause (LICENSE alongside). Used by `placer-pyplacer` (RFC 11 §8.2, ADR 0008) as an out-of-process placement engine; copperhead never imports it as a library. Needs Python 3.10+ with numpy.

Two patches, marked `copperhead patch` in the source:

- `run.py` gains `--fixed <ref,…>`; `kicad_pcb.py`'s `Footprint.fixed` honours that list when given, else upstream's rule (refdes starting with `J` or `H` stay put). This is how a job's `lockedComponentIds` reach the engine.

- `placer.py` guards the final "improvement" print against a zero initial cost (upstream divides by it).

`export_dsn.py` and `patch_pcb_rnd.py` are not vendored (a pcbnew call and an unrelated tool).

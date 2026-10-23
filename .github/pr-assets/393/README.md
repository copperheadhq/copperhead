# PR 393 placement comparison

These renders were generated from PR head `03979647ab5c57c76bd1f90e3d2eef71aa5f270f`
with KiCad 9.0.8. The input is the repository's five-part drafting fixture,
populated from an empty board with the deterministic `populateBoard` path.
The after board is the output of `optimizePlacement` using a 5,000-evaluation
ceiling and the step schedule `[5, 2.5, 1, 0.5, 0.25]`.

| Measurement | Before | After |
| --- | ---: | ---: |
| HPWL | 74.460 mm | 33.607 mm |
| Placement warnings | 2 | 1 |
| In-memory hard errors | 0 | 0 |
| KiCad DRC violations | 0 | 0 |
| Unrouted connections | 8 | 8 |

The deterministic search accepted 29 moves in 812 candidate evaluations and
stopped at a local optimum. The connector remained locked. Both boards were
independently checked with `kicad-cli pcb drc`; the after render was produced
only after the DRC and unrouted-count gates passed.

# Vendored: tscircuit calculate-packing

- **Upstream:** <https://github.com/tscircuit/calculate-packing>
- **Commit:** `a2d60ae` (tag v0.0.89, 2026-08-30)
- **Vendored on:** 2026-09-16, for the OpenSpec change `add-reuse-placer`
  (requirement "Vendored geometry engine").
- **Licence:** MIT, reproduced in full below.
- **Entry point:** `facade.ts`. Nothing outside this directory imports any
  other file here.
- **Runtime dependency:** `@flatten-js/core` 1.6.14 (MIT), pinned exactly. It
  is the only package this directory imports; `test/vendor-imports.test.ts`
  enforces that.

## MIT licence

```text
MIT License

Copyright (c) 2025 tscircuit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Files kept

Every file below is upstream `lib/<path>`, copied to `<path>` here. Each one
starts with `// @ts-nocheck` (upstream code is outside copperhead's strict
type checking) and a comment naming its upstream path. Relative imports were
given `.js` extensions for NodeNext, and upstream's bare `lib/...` imports
were rewritten as relative paths.

```text
LargestRectOutsideOutlineFromPointSolver.ts
OutlineSegmentCandidatePointSolver/OutlineSegmentCandidatePointSolver.ts
OutlineSegmentCandidatePointSolver/getOutwardNormal.ts
PackSolver2/PackSolver2.ts
PackSolver2/checkOverlapWithPackedComponents.ts
PackSolver2/getComponentCollisionBoxes.ts
PackSolver2/setPackedComponentPadCenters.ts
PackSolver2/sortComponentQueue.ts
SingleComponentPackSolver/SingleComponentPackSolver.ts
constructOutlinesFromPackedComponents.ts
geometry/combineBounds.ts
geometry/convexHull.ts
geometry/expandRotatedRectIntoBounds.ts
geometry/getComponentBounds.ts
geometry/getInputComponentBounds.ts
geometry/pointInOutline.ts
geometry/simplify-collinear-segments.ts
geometry/types.ts
math/computeNearestPointOnSegmentForSegmentSet.ts
math/cross.ts
math/expandSegment.ts
math/getPolygonCentroid.ts
math/isPointInPolygon.ts
math/rotatePoint.ts
pack.ts
parseFlattenPolygonLoops.ts
solver-utils/BaseSolver.ts
solver-utils/IrlsSolver.ts
solver-utils/MultiOffsetIrlsSolver.ts
solver-utils/TwoPhaseIrlsSolver.ts
solver-utils/makeNumbersRounded.ts
types.ts
utils/createWeightedConnectionIndex.ts
utils/getStronglyConnectedPadIds.ts
utils/getWeightedConnectionIndex.ts
utils/isStrongConnection.ts
```

`LargestRectOutsideOutlineFromPointSolver.ts` is kept because
`OutlineSegmentCandidatePointSolver` uses it to size the free rectangle along
an outline segment.

**Not copied:** every `*.test.ts`, `lib/index.ts` (replaced by `facade.ts`),
`lib/testing/` (visualisation and test helpers) and `lib/plumbing/`
(circuit-json conversion).

## Files written by copperhead

```text
facade.ts                                 the typed entry point (see its header for the semantics)
local/math-utils.ts                       P1 replacement for @tscircuit/math-utils
local/graphics-debug.ts                   P1 replacement for the graphics-debug types
local/debug-graphics.ts                   P1 replacement for lib/testing/ (getColorForString is upstream)
geometry/isComponentInsideBoundaryOutline.ts  P2 exact containment
utils/getNetworkWeight.ts                 P3 network weight lookup
```

## Patches

### P1 — local replacements for undeclared helper imports

*Files:* `local/math-utils.ts`, `local/graphics-debug.ts`,
`local/debug-graphics.ts`, `solver-utils/BaseSolver.ts`, and the import
statement of every file that used one of them.

Upstream imports `@tscircuit/math-utils` (`computeDistanceBetweenBoxes`,
`clamp`, `Bounds`, `Point`), `@tscircuit/solver-utils` (`BaseSolver`),
`graphics-debug` (types only) and `lib/testing/` (colours, visualisation),
all of them declared as dev dependencies only; taking them as real
dependencies pulled in tens of megabytes. Each is replaced by a local module.
`BaseSolver` needed no new file: upstream already carries
`lib/solver-utils/BaseSolver.ts`, which its own IRLS solvers extend, and it is
API-compatible with the published `@tscircuit/solver-utils` class (same
fields and methods); the two differ only in that the published one compares
`iterations >= MAX_ITERATIONS` where the local one uses `>`, and in a
`noisySolve` helper. The local copy is used everywhere, so all solvers now
share one base class. Its two `console.error` calls were removed: library code
must not write to the console, and the message is still on `solver.error`.

`computeDistanceBetweenBoxes` is reimplemented as the **exact** Euclidean gap
between two boxes (0 when they touch or overlap). This deliberately differs
from `@tscircuit/math-utils` 0.0.38, which measures between each box's centre
clamped into the other box: that overestimates the gap whenever the boxes'
projections overlap on one axis and their centres are offset along it (boxes
`[-1,1]x[-5,5]` and `[2,4]x[-1,9]` are 1 apart, but it reports 4.12), so a
`minGap` of 2 would wrongly pass. Every caller compares the result against
`minGap`, so the exact gap is what they mean; it still reports 0 for real
overlaps, as the upstream version does.

### P2 — exact containment of collision boxes in the boundary polygon

*Files:* `geometry/isComponentInsideBoundaryOutline.ts` (new),
`SingleComponentPackSolver/SingleComponentPackSolver.ts`,
`PackSolver2/PackSolver2.ts`.

Upstream accepted a candidate when its pad centres and the four corners of its
bounding box were inside the outline. On a concave outline that lets a
component straddle a notch or a cut-out: the corners sit in the material on
either side while the body crosses empty space. A component is now inside only
when every collision box and every pad box has all four corners inside (within
1e-6 mm, so a part flush with the edge is still accepted) **and** no boundary
segment crosses a box's interior. The same check replaced the copy in
`PackSolver2.packFirstComponent`, which also gained the bounds check it never
had, and the `bounds` comparison gained the 1e-6 tolerance the gap checks
already used, so that rounding cannot reject a part sitting flush.

### P3 — weighted network distance

*Files:* `utils/getNetworkWeight.ts` (new), `types.ts`,
`SingleComponentPackSolver/SingleComponentPackSolver.ts`,
`OutlineSegmentCandidatePointSolver/OutlineSegmentCandidatePointSolver.ts`,
`solver-utils/MultiOffsetIrlsSolver.ts`, `solver-utils/TwoPhaseIrlsSolver.ts`.

Upstream's `weightedConnections` only filters weak connections; every net then
counts the same in the cost, so a decoupling capacitor pulls no harder than a
status LED. `PackInput` gains `networkWeights: Record<string, number>`, which
is threaded to the single-component solver and to the candidate-point solver.
Each pad's term in the cost is multiplied by the weight of its network
(default 1), and a network weighted 0 contributes nothing: it is dropped from
the target points, so it does not even move the optimiser. The weights reach
the optimisation as well as the final score — the IRLS/Weiszfeld step in
`MultiOffsetIrlsSolver` scales each target's weight, and `TwoPhaseIrlsSolver`
chooses its phase-2 target by weighted distance — because weighting only the
final `calculateDistance` would rank candidate points that were optimised for
the unweighted cost.

### P4 — no silent fallback placement

*Files:* `PackSolver2/PackSolver2.ts`,
`SingleComponentPackSolver/SingleComponentPackSolver.ts`.

Upstream had three silent failure modes. `packFirstComponent` placed the first
component at the centre "even if it violates constraints"; a sub-solver that
produced no result placed its component at (0, 0); and inside
`SingleComponentPackSolver` the empty-packed-set shortcut accepted (0, 0)
after checking obstacles only, ignoring the bounds and the boundary, which put
the first part of a board drawn at KiCad coordinates at the origin, far off
the board. A component with no legal position is now recorded as unplaced with
its reason and skipped, and packing continues with the rest, so one impossible
component no longer decides the whole result. For the same reason, a
sub-solver that fails — including one that throws — no longer fails the entire
solve.

### P5 — failure detail

*Files:* `types.ts`, `SingleComponentPackSolver/SingleComponentPackSolver.ts`,
`PackSolver2/PackSolver2.ts`, `pack.ts`.

`UnplacedComponent` records `{ componentId, rotationsTried, closestRejection,
message }`. `closestRejection` is `overlap`, `obstacle`, `bounds`, `boundary`
or `none`: the check that rejected the lowest-cost candidate position, which
is the position the packer would otherwise have chosen; when the component is
larger than the board in every rotation tried, that is reported instead, since
it is the root cause; and `none` means no candidate position was generated at
all. The message adds the counts per reason, the number of segment/rotation
pairs with no room, and any solver error. The list is exposed as
`PackSolver2.getUnplacedComponents()`, in `PackSolver2.getOutput()` and on
`pack()`'s output, and it includes components upstream dropped in silence —
one with no pads, or with a pad of non-positive or non-finite size — and, when
a solve stops at the iteration cap, the component in progress and those still
queued.

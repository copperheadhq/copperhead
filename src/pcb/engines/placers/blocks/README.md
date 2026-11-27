# placer-blocks

Our own placer, built one brick at a time. Each brick does one thing, is
measured before the next is started, and does not break the one before it.

## Why it exists

Measured on `esp32-amp` at 40 × 50 mm, across six floorplan candidates, the
engines already wrapped by the harness placed **17% to 47%** of parts inside the
region their subsystem was given, by a mean of **6 to 12 mm** out on a 40 mm
board. A region was advisory at every level it passed through:

- the intent language could not state one, so a floorplan had to be smuggled in
  as a pinned anchor plus a spread budget, which is a disc, not a rectangle;
- the vendored packer packs against one boundary, the whole board;
- the checker that noticed logged a warning at `gate: 'none'`;
- and the one rule that did enforce regions ran last, by which point the staged
  plan had locked 22 of 30 parts, so it could reach only 6.

Correcting a placement afterwards cannot fix that. Deciding it inside the region
can. `placer-blocks` decides.

## Bricks

| brick | does | state |
| --- | --- | --- |
| 1 | every part inside its subsystem's region, no overlap, packed by footprint | **done** |
| 2 | anchor first, then its attached parts beside the pin they name | **done** |
| 3 | connectors on the edge they were given, inside their region | **done** |
| 3a | the radio's antenna keep-out kept clear (its position done in brick 3) | **done** |
| 3b | the floorplanner charges a block for its keep-out | next |
| 3c | reconcile block membership against placement reality | next |
| 4 | orientation: a connector faces the edge it sits on | next |
| 4a | grid snap: every part on a 0.1 mm grid | planned |
| 5 | pad-facing orientation: a satellite's pads point at the pin it serves | planned |
| 6 | hot-loop area: the switching loop placed as a cluster, not part by part | planned |
| 7 | chains laid along the path, in order | planned |
| 8 | isolation, thermal and separation as a repair pass | planned |
| 9 | matched pairs placed symmetrically | planned |
| 10 | consistent passive orientation and row alignment | planned |

### Brick 1: containment

**Contract.** Every part goes inside the region its subsystem was given, or it
is reported in `unplacedComponentIds`. Nothing else: no wirelength, no
attachments, no rotation. The manifest says so — `rotation: false`,
`relativeConstraints: []`.

**Method.** Shelf packing, largest footprint first, rows filled left to right
and top to bottom inside the region. Deterministic, no parameters to tune, and a
legible failure mode: a part that does not fit says so rather than landing
somewhere plausible and wrong.

**Result.** 100% in block, 0 overlaps, 0 unplaced, on all six candidates.

**Two things learned the hard way, both worth keeping:**

*A part is charged by its pads and fabrication body, never its courtyard.* A
courtyard is a clearance zone, and `importBoard` collapses disjoint pieces into
their common bounding box — for `ESP32-S3-WROOM-1` that fuses a 19.5 × 20.2 mm
module with its 48 × 21 mm antenna keep-out into a 48 × 41.2 mm rectangle that
fits inside no region on a 40 mm board. Clearance between parts is applied
separately, as a gap.

*Regions that touch leak clearance into each other.* A part packed flush against
a shared boundary carries its halo across it, so a neighbouring region's edge is
routinely obstructed by a fraction of a millimetre. The first version stepped
past an obstruction by a fixed amount and wrapped to a shelf barely lower, so it
retried the same blocked column until its guard gave up — and reported J2
unplaceable in a region with room for it twice over. It now steps to just past
the blocker's far edge. **Any per-region packer has to expect a fractional
obstruction on every shared edge; it is the normal case, not the exception.**

### Brick 2: anchor first, satellites at their pins

**The finding that shapes it.** Of the 18 attachments `esp32-amp` states, **17
target their own block's anchor** and **all 18 name a specific pin**.
Attachments are not a cross-cutting constraint — they are intra-block,
anchor-to-satellite. So brick 2 is not a separate pass; it is a change to brick
1's ordering inside each region:

1. place the block's anchor, positioned to leave room on the sides its attached
   pins face;
2. place each attached part at the nearest free spot to the **pad** it names,
   inside the region;
3. shelf-pack the rest into what is left, exactly as brick 1 does.

**Why this and not something else.**

*It fixes the pin-versus-component bug by construction.* `placer-attach` measures
from the target's whole pad bounding box, so every pin on a 19 mm-wide module
yields the same position about 10 mm out, and a 2 mm decoupling budget is
unreachable however the search is tuned. Measuring from the pad makes the budget
achievable rather than approximately satisfiable.

*It reuses what already works.* The occupancy test, the clearance halo, the
step-past-blocker rule and region containment are all unchanged. Only the order
changes, plus a pin-anchored seed position, and the fallback is brick 1's own
shelf packer — so brick 1's result is preserved by construction.

*It is the largest measured gap.* 8 of 18 attachments missed, identically on
every candidate: the one number no floorplan choice affects.

**Result.** In block 100%, overlaps 0, unplaced 0, and attachments missed **7 of
108** across the six candidates — 0 to 2 per board, against 8 of 18 per board
from the engines the harness already wraps. Candidate (b) meets all 18.

| | existing engines | brick 1 | brick 2 |
| --- | --- | --- | --- |
| in block | 17–47% | 100% | 100% |
| attachments missed, per board | 8/18 | 18/18 | 0–2/18 |
| overlaps | 5–9 | 0 | 0 |

**The bug this cost, and the rule it leaves behind.** The first cut scored 81 of
108 — worse than the engines it was meant to beat. The tell was that the placer
logged one over-budget attachment while the measurement found twelve misses:
satellites were not reaching step 2 at all. `pad.at` returns where the bootstrap
grid left the pad, but the anchor had just been moved to the region centre, so
the search ran around a stale coordinate usually outside the region, returned
nothing, and the part fell silently through to the shelf packer.

> Once a part has been moved, every coordinate derived from it is stale. The IR
> is immutable, so nothing warns you. A placer that moves parts in steps must
> carry the offsets forward itself.

Pads now follow their part through a `moved` delta, and a satellite that cannot
be seeded at its pin says so rather than disappearing into the shelf packer.

**Open question, still open.** Where in its region does the anchor go? It is
centred today, which brick 3a shows is wrong for any part that owes an edge. Top-left is certainly wrong — satellites need to surround it —
but biasing the anchor so the pins carrying attachments face into free space
should beat centring: on `esp32-amp`, U1's decoupling is on pad 2 and its EN
network on pad 3, both on one edge of the module, so centring U1 wastes the far
side. The 7 remaining misses are the budget for that experiment; most are `SW2`
against a 12 mm budget the region geometry does not allow.

### Brick 3: connectors on the edge they were given

**A conflict to resolve upstream first, not a feature to add here.** Checked
across the six candidates before writing any placer code:

```
(a) J1→south in power-input: CONFLICT   J2→east: CONFLICT   J3→west: CONFLICT
(b) J1→south in power-input: CONFLICT   J2→east: ok         J3→west: ok
...
```

`J1 → south` conflicted on **all six**: `power-input`'s region never reached the
south edge, so the USB-C receptacle could be inside its block or on the edge a
plug reaches, never both. Either answer is wrong — off the edge is a board
nobody can plug into, outside the block fails the region gate — so the floorplan
was asking for something impossible and any placer built against it would have
measured a failure that was not its own.

**Fixed in the floorplanner.** The `edge` cost term only asked that a block
holding a connector reach *some* edge. It now carries the edge each member is
required to reach, from `placement.fixed[].edge` and `placement.rf[].edge`, and
rejects a layout whose region cannot reach it. Feasible layouts fall from 420 to
**52** — constrained, not over-constrained — and all four constraints are
satisfiable on all six candidates.

> Information was flowing the wrong way: `connectorEdgeConstraints` derives a
> connector's edge *from* the region it landed in. When the intent names an
> edge, the region must follow the connector, not the other way round.

**Then the placer.** Inside each region, before the anchor:

1. place each part that owes an edge against that edge, within its region —
   they have the least freedom, so they choose first;
2. anchor, satellites and shelf packing follow as in bricks 1 and 2.

**Result.** Edges met **4 of 4 on all six candidates** — J1 south, J2 east, J3
west, U1 north, every one inside its own region. Containment stays at 100% and
overlaps at 0.

| | brick 1 | brick 2 | brick 3 |
| --- | --- | --- | --- |
| in block | 100% | 100% | 100% |
| edges met | — | — | 4/4 on all six |
| attachments missed, per board | 18/18 | 0–2/18 | 0–3/18 |
| overlaps | 0 | 0 | 0 |

That was only possible because the floorplan was fixed first. Built against the
old floorplans it would have scored 1 of 4 and the failure would have looked
like the placer's.

**It costs attachments, correctly.** Missed attachments go from 7 of 108 to 10.
J1 is the target of four of them (R1, R2, D1, F1), so pinning it to the south
edge moves all four off their best spot. Three per board at worst, against a
hard requirement met — the right trade, and worth stating so it is not later
mistaken for a regression.

**Scope note.** The same mechanism handles `placement.rf[].edge`, not only
connectors: positioning a radio at its edge is identical code, and duplicating
it under brick 3a would have been worse. **Brick 3a's position half is therefore
already done**, and only the keep-out exclusion remains — which is the half that
matters, since 18 parts still sit in the antenna zone.

### Brick 3a: the antenna

**Found by asking the question, not by the metric.** Bricks 1 and 2 place up to
**18 of 30 parts inside U1's antenna keep-out**. Candidates (c), (d) and (e) put
most of the board in it — J2, U3, U2, both ferrites, nearly all the passives —
and even the best three leave J3 there. The zone is 48 × 21 mm; a part in it
does not stop the board being fabricated, it stops the radio working.

Three separate failures let that through, and all three are worth recording:

*The placer has never heard of the keep-out.* `importBoard` carries board-level
`zone` blocks only, so a keep-out declared **inside** a `footprint` — as
ESP32-S3-WROOM-1 declares its antenna clearance — never reaches
`design.board.keepouts`, which is empty on this board. `taken` holds parts and
nothing else, so there is no obstacle to avoid. The geometry has to be read off
the footprint s-expression, exactly as `manual-tests/floorplan-probe` does.

*The metric said 100% the whole time.* `review.ts` measures the strip between the
module and the board edge. That is not the keep-out: the real zone is centred on
the antenna and reaches sideways and inward, far past that strip. **A metric
measuring the wrong rectangle is worse than no metric — it reports success while
the thing it names gets worse.** Fix the scorer before building against it.

*Brick 2 centres the anchor, which is precisely wrong for a radio.* Centring
pulls the module inward so more of its keep-out lands on the board instead of
hanging off the edge. Brick 3's edge rule has to override brick 2's centring for
any part that owes an edge.

**So brick 3a is two requirements, not one:**

1. **Position.** The radio sits against its edge with the keep-out pointing
   outward, so most of the 48 × 21 mm zone is over air. Mounted flush, what
   stays on board is roughly a 6 mm strip — the module's own PCB runs that far
   past its courtyard ring.
2. **Exclusion.** Whatever remains on board is an obstacle. No part may be
   placed in it, and later no copper poured in it. It enters `taken` before any
   part of any block is placed, because it constrains every region it crosses,
   not just `mcu`.

Note the ordering consequence: the keep-out is a *global* obstacle owned by one
block. Regions are packed one at a time, so it must be seeded before the loop,
like the static parts are.

**Result.** Keep-out intruders **18 → 0 on every candidate**, measured against
the real 48 × 21 mm zone rather than the edge strip the metric used to test.

| | brick 3 | brick 3a |
| --- | --- | --- |
| keep-out intruders | 18 | 0 |
| in block | 100% | 98% |
| edges met | 4/4 on all six | 4/4 on four, 3/4 on (c) and (e) |
| attachments missed, per board | 0–3/18 | 0–4/18 |
| unplaced | 0 | 5 |
| overlaps | 0 | 0 |

**The cost is real and it is information.** 48 × 21 mm on a 40 × 50 board is the
full width and 42% of the height; it has to come out of somewhere. On (c) and
(e) a connector can no longer reach its edge and two parts have nowhere to go.
Those floorplans were never viable once the antenna is accounted for — they only
looked viable while the zone was invisible. (a), (b) and (f) absorb it cleanly.

**The implementation is uglier than this document promised.** It said the zone
seeds `taken` before the region loop. It cannot: where the zone lands depends on
where its owner goes. So the owner is placed first under brick 3's edge rule,
out of loop order, and the zone seeded after. That duplicates the edge-placement
logic, which wants factoring out before brick 4 builds on it.

### Brick 3b: the floorplanner charges a block for its keep-out

The floorplanner sizes `mcu` from U1's occupancy alone and knows nothing about
the 48 × 21 mm zone, so it proposes regions that cannot hold their block once
the zone is reserved — which is exactly how (c) and (e) came to be offered.
Adding the on-board part of a keep-out to a block's area demand would stop those
layouts being proposed at all, which is better than the placer coping with them
downstream. It also removes the case where a candidate looks good on cost and
then fails on capacity.

### Brick 4: orientation

A connector must also *face* the edge it sits on. `matingFace` already exists in
`engines/legalize.ts` and is measured, not guessed: an edge connector's body
overhangs its pads on the side the plug arrives from — 2.31 mm against 0.50 mm
elsewhere for a USB-C receptacle, 2.50 against 0.51 for a horizontal terminal
block. A part with no such asymmetry has no in-plane facing and is left alone; a
vertical pin header overhangs 0.92 mm on all four sides because it is mated from
above.

Reuse it here rather than reimplementing. Note it does **not** work for the
WROOM — 18.3 mm north against 14.5 mm east and west is a ratio of 1.26, below
the 1.5 threshold — because a module's antenna direction lives in its keep-out
zone, which the IR drops. The radio is placed against its edge without rotating,
which is right for a module already oriented by its footprint.

## Audit of the best layout, after brick 3a

Measured on candidate (b), the cleanest of the six. Everything below is a gap in
what is built, not a defect in it — recorded so the roadmap answers the board in
front of us rather than a generic one.

```
rotations used:  0deg x30
HPWL total       469 mm   worst: GND 72.5 (49 pads), +3V3 64.3 (9), /BCLK 38.6 (2)
hot loop         U3-C6-C7-CP1  94 mm² against 40
chains           U3->FB1->C8->J2  15.4 mm against 18   (ok)
                 U3->FB2->C9->J2  19.0 mm against 18   (over)
isolation        24.1 mm against 8                      (passes)
cross-block      CP1(power-input) -> U3(amplifier)  24.0 mm, budget 12
```

**1. Every part is at 0°.** Nothing is ever rotated. It is the largest single
gap: it leaves the I2S nets long (`/BCLK` 38.6 mm, `/LRCLK` 38.3, `/DIN` 36.0,
each between just two parts) and lets a decoupling cap 1 mm from its pin point
its pads the wrong way. Bricks 4 and 5 both bear on this and neither is built.

**2. The hot loop is 2.4× its budget, and the partition is the reason.** CP1 is
the class-D bulk capacitor for U3, but the schematic files it under *Power
Input*. The region constraint is hard and the 12 mm attachment is not, so the
region wins and CP1 ends up 24 mm from the pin it serves. This is the one
attachment of eighteen that crosses a block boundary, and it is the one that
matters most electrically.

**3. The two output chains are not symmetric.** `U3→FB1→C8→J2` is 15.4 mm and
its twin `U3→FB2→C9→J2` is 19.0, over budget. They carry the two halves of one
bridged output and should mirror each other (roadmap item 9).

**4. Rails are unplanned.** `GND` spans 72.5 mm over 49 pads and `+3V3` 64.3 mm
over 9. Nothing here knows a net is a rail. They will be poured, so raw HPWL
overstates the cost, but no pour planning exists either.

**5. Nothing measures routability.** HPWL is the only wirelength number and it
counts rails that will be poured. No ratsnest crossings, no congestion estimate,
so "is this routable" is simply unanswered.

**6. Isolation passes by accident.** 24.1 mm against an 8 mm floor, because the
floorplan happened to separate them. No rule enforces it.

### Brick 3c: reconcile block membership against placement reality

The audit's finding 2 is not a placer bug. `deriveBlocks` takes the schematic's
`group` field as truth, and **a schematic sheet grouping is not a floorplan
grouping**. Nothing currently reconciles the two, so a part can be required to
sit in one region and within 12 mm of an anchor in another.

> When an attachment crosses a block boundary and its budget is tight, the part
> probably belongs in the other block. `CP1 → U3.7` at 12 mm is a stronger
> statement about where CP1 goes than the sheet it happened to be drawn on.

Cheap to detect — exactly one attachment of eighteen crosses — and fixing it
should take the hot loop from 94 mm² toward its 40 mm² budget, which is the most
important physical relationship on this board. Worth doing **before brick 4**:
rotating a part into a better position cannot help a part that is in the wrong
region to begin with.

## Roadmap beyond brick 4

Ordered by impact times cheapness. Most are already measurable the day they are
built: eighteen `intent.*` checkers exist, and the ones that apply are named
below.

**Tier 2 — the board works, but badly.**

- **5. Pad-facing orientation.** The largest remaining lever, and no new inputs
  needed. A decoupling cap 1 mm from its pin but turned 90° needs a longer,
  worse trace than one whose pads face it. Brick 2 already searches for the
  nearest free spot to a pad; choosing the rotation that puts the part's own
  nearest pad toward that pin is the same loop plus a four-way trial. This is
  what makes a placement look deliberate rather than merely close.
- **6. Hot-loop area.** `intent.emc.hot-loop`, stated at ≤ 40 mm² for
  U3/C6/C7/CP1 and currently measured at 67.4. On a class-D amplifier it is the
  most important physical relationship on the board. Needs the loop placed as a
  deliberate cluster rather than each member independently near its own pin, so
  it does not fall out of brick 2 for free.
- **7. Chains.** `intent.relative.chain.length` and `.order`, both failing today
  on U3 → FB1 → C8 → J2. A chain wants laying along a line from source to sink;
  the region gives it somewhere to lie.

**Tier 3 — robustness.**

- **8. Isolation, thermal, separation.** `intent.emc.isolation`,
  `intent.thermal.distance`, `intent.functional.separation`. All pairwise
  distances over a finished placement, so they belong in a repair pass rather
  than the placement rule.
- **9. Matched pairs.** FB1/FB2 and C8/C9 carry the two halves of a bridged
  output and should be mirror-symmetric. Cheap, and obvious when wrong.
- Group spread (`intent.functional.group.spread`) comes free once regions bound
  it, and needs no work of its own.

**Tier 4 — polish, cheaper than it looks.**

- **4a. Grid snap.** Scheduled early, out of tier order, precisely because it is
  nearly free and changes how every render reads from then on. A board on a
  0.1 mm grid looks hand-laid; one on arbitrary coordinates looks like solver
  output whatever else is right about it.
- **10. Consistent passive orientation and row alignment.** Same rotation for
  every 0402 unless a constraint says otherwise: a real assembly benefit for
  pick-and-place and polarity inspection, and a strong human-acceptance signal.
  Row alignment falls out of shelf packing almost for free.
- **Congestion balance** is deliberately *not* on this list. Packing one region
  to 95% while its neighbour sits at 30% is the floorplanner's area allocation
  to answer, not the placer's — the same lever that would stop `mcu` being 2.4×
  its demand.

## Measuring

`manual-tests/floorplan-probe/review.ts` scores a placed board on intent
conformance, lexicographically, worst class first: containment, antenna, facing,
attachments, overlaps, edge gap. It is the only judgement that matters here —
the placement profile scores wirelength and overlaps, which say whether a board
is manufacturable, not whether it is the board that was asked for.

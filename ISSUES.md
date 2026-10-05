# Copperhead Fabrication-Readiness Issues

This backlog was derived from the `01-usbc-5v-breakout` create run. The board is
useful as a regression fixture because it passed ordinary ERC/DRC checks while
still containing release-blocking uncertainty. Each issue below targets the
Copperhead pipeline; the generated board must not be repaired by hand to hide a
pipeline defect.

## Priority order

| Priority | Issue | Required outcome | Status |
|---:|---|---|---|
| 1 | Gate manufacturing export on release readiness | An acknowledged draft cannot become an apparently orderable package | Resolved by `bdeddc8` |
| 2 | Prevent invented or draft PCB footprints | The PCB contains only exact, schematic-assigned library footprints | Next |
| 3 | Make schematic legibility a final create gate | A create run cannot finish with error-severity drawing defects | Backlog |
| 4 | Separate draft completion from fabrication readiness | Every terminal state communicates the achieved assurance level | Backlog |
| 5 | Turn BOM uncertainty into evidence-backed work | Every release-critical part claim is verified or blocks release | Backlog |
| 6 | Verify electrical current-path claims | A claimed current rating has traceable component and copper evidence | Backlog |

## 1. Gate manufacturing export on release readiness

### Observed failure

The `01-usbc-5v-breakout` repository contained Gerbers and drill files even
though all six PCB footprints differed from the schematic assignments, BOM
parts were marked `UNVERIFIED`, release documentation was incomplete, and the
outputs had no recorded provenance.

### Root cause

Stage 6 called the KiCad exporters directly. Ordinary `check` only established
ERC, DRC, drift, and constraint consistency. It did not establish routing
completeness, orderable BOM data, schematic/PCB footprint parity, release-note
presence, or freshness of generated files. Consequently, “DRC-clean draft” and
“safe manufacturing input” shared the same export path. The create pipeline
also had no source-content hash tying its output files to the PCB bytes that
produced them.

### Resolution

- Run a deterministic fabrication preflight before invoking any exporter.
- Use strict BOM checking for autonomous export and final create verification.
- Refuse export on unrouted connections, missing or unverified BOM data,
  schematic/PCB mismatch, or incomplete layout-release documentation.
- Record the source-board SHA-256 and generated file paths only after every
  exporter succeeds.
- Treat missing files or a changed board hash as stale output.
- Retain non-strict `check --fab` only as an explicit human-facing inspection
  mode; `check --fab --strict` is the release gate.

### Acceptance evidence

- A footprint mismatch names the refdes, never calls the exporter, creates no
  `outputs/` directory, and records no provenance.
- An `UNVERIFIED` BOM row blocks autonomous export.
- A successful export records hash-backed Gerber and drill paths.
- Final `create` calls the fabrication check with strict mode enabled.

## 2. Prevent invented or draft PCB footprints

### Observed failure

Every `01-usbc-5v-breakout` PCB footprint used an invented `_DRAFT` name, such
as `USB_C_Receptacle_USB4105_DRAFT`, while the schematic named an exact KiCad
library footprint. DRC could still pass because DRC checks geometry already on
the board; it does not prove that geometry came from the selected library part.

### Root cause

The affected layout run allowed the layout agent to author or preserve
footprint geometry independently of the schematic assignment. Its completion
criteria were based on the existence of placed footprints, DRC cleanliness,
and a `Draft quality` section, rather than an exact identity check over
`(reference, library footprint ID, pad set, pad nets, library geometry)`.
Therefore a plausible-looking substitute footprint could satisfy the stage even
though its land pattern had no authoritative source.

### Required pipeline fix

- Populate the PCB deterministically from exact schematic footprint IDs before
  the layout agent runs.
- Refuse missing libraries or footprint names; never synthesize a similarly
  named fallback.
- Prevent the agent from adding, deleting, renaming, or rewriting footprints.
- At layout completion, compare reference sets, footprint IDs, pad numbers, pad
  nets, and library geometry against the schematic and installed library.
- Retry from the last verified populated board if parity is lost.
- Add `01-usbc`-shaped coverage proving that every `_DRAFT` substitution fails.

### Acceptance criteria

A create run cannot enter the outputs stage unless every physical component is
an exact instance of its schematic-assigned library footprint and every pad is
on its schematic net.

## 3. Make schematic legibility a final create gate

### Observed failure

The generated USB-C schematic had three error-severity findings: overlapping
group captions and two captions extending outside their group rectangles. Its
composite score was capped at 40, yet the overall pipeline continued.

### Root cause

Legibility is computed and reported separately from electrical verification.
Ordinary `runCheck().ok` does not include error-severity legibility findings.
Stage-local gates can protect a newly executed schematic stage, but a resumed,
grandfathered, or otherwise skipped stage can reach the final create check with
an invalid drawing. The final gate therefore does not independently reassert
the schematic-stage presentation contract.

### Required pipeline fix

- Include error-severity legibility findings in final create success for
  create-authored schematics.
- Re-run the checker after the last schematic mutation and at final completion.
- Feed exact findings back to `draft_schematic` and repair the intent rather
  than hand-editing generated geometry.
- Ensure resumed stages cannot bypass the final legibility assertion.
- Add a regression using adjacent narrow groups such as `VBUS TVS` and `PTC`.

### Acceptance criteria

Final create completion requires zero error-severity schematic findings. An
advisory score may be reported, but an error cannot coexist with a successful
create outcome.

## 4. Separate draft completion from fabrication readiness

### Observed failure

The pipeline report and generated output directory made `01-usbc` appear
complete even though `LAYOUT.md` explicitly required specialist review of land
patterns, connector placement, protection layout, and the 3 A path.

### Root cause

The pipeline exposes a mostly boolean success model. Stage success means that
the contract for that drafting stage was met, but the final user-facing language
does not consistently distinguish this from product release readiness. A
`Draft quality` disclaimer records uncertainty without changing the terminal
state, allowing “completed draft” to be interpreted as “approved to order.”

### Required pipeline fix

- Introduce explicit outcomes such as `draft-complete`,
  `verification-required`, and `fab-ready`.
- Derive `fab-ready` exclusively from the strict deterministic fabrication gate.
- Surface release blockers in the final summary, JSON output, and exit status.
- Keep provisional artifacts under a clearly marked draft location until the
  release gate passes.
- Never print “all checks green” when warnings or required human verification
  remain.

### Acceptance criteria

Users and automation can determine the assurance level without interpreting
free-form prose. Only `fab-ready` artifacts are presented as orderable.

## 5. Turn BOM uncertainty into evidence-backed work

### Observed failure

All `01-usbc` parts were marked `UNVERIFIED`, including the USB-C connector,
TVS, polyfuse, output header, and CC resistors. The marker did not identify the
missing evidence or give the pipeline a deterministic way to close it.

### Root cause

BOM verification state is encoded as free-form Markdown text. Copperhead can
detect the word `UNVERIFIED`, but it has no structured record for the claim,
evidence source, datasheet revision/page, verification method, or responsible
stage. There is also no completed part-research stage that converts candidate
parts into evidence-backed selections. Thus uncertainty can only be carried or
blocked; it cannot be systematically resolved.

### Required pipeline fix

- Store per-part verification fields for MPN identity, footprint fit, pin map,
  polarity, electrical ratings, temperature derating, availability, and cost.
- Require authoritative evidence with source URL, document revision, page or
  table, extracted value, and retrieval date.
- Add a deterministic validation layer over the evidence record.
- Add a part-research workflow that may gather evidence but cannot mark a claim
  verified without satisfying its schema.
- Keep unavailable or conflicting evidence as an explicit release blocker.

### Acceptance criteria

Every release-critical BOM claim is traceable to evidence, and strict fab
checking names the exact missing claim for each blocked refdes.

## 6. Verify electrical current-path claims

### Observed failure

The design claimed a 3 A path while its own layout notes said the 1.5–2.0 mm
tracks were draft geometry and did not prove connector, header, PTC, pad, via,
voltage-drop, or temperature-rise capability.

### Root cause

The 3 A requirement exists as prose and a free-form constraint, not as a
machine-evaluable path model. KiCad DRC checks geometric rule compliance and
connectivity; it does not infer allowable current from copper thickness,
temperature rise, component derating, or contact ratings. Copperhead has no
graph connecting the requirement to every series element and no calculation or
evidence gate that can prove the weakest element meets the claim.

### Required pipeline fix

- Represent current requirements and board stack-up as structured constraints.
- Trace each governed net from source to load through tracks, vias, pads,
  protection devices, connectors, and headers.
- Calculate copper temperature rise and voltage drop with explicit assumptions.
- Combine calculated copper limits with evidence-backed component and contact
  ratings, including worst-case temperature derating.
- Report the limiting element and fail strict fab readiness when evidence or
  margin is missing.
- Record calculations and assumptions as reproducible release artifacts.

### Acceptance criteria

A current claim is accepted only when every element in its complete path has a
verified rating at or above the requirement and the calculated copper geometry
meets the configured thermal and voltage-drop limits.

# add-pcb-layout-framework: Implementation Specification

This is the engineering-level specification for the change: what gets built, where, with which types, on-disk formats, process protocols, commands, and tests. It sits below the RFC (the standard) and the delta specs (the requirements) and above `tasks.md` (the checklist). Section numbers written as RFC §n refer to [RFC 11](https://github.com/copperheadhq/copperhead-rfcs/blob/main/rfc/rfc11.md); numbers without a prefix refer to this document. Each part is tagged with the delivery phase (P0 to P5, per RFC Appendix B) that lands it.

Facts verified on the reference machine on 5 September 2026 are marked *(verified)*; everything else about an external project is pinned by the Phase 0 teardown and MAY be revised by its ADR.

## 1. Layout of the code

```text
src/pcb/
  ir/                      P1  the IR and the KiCad adapter (RFC §6)
    types.ts               PcbDesign and every record it contains
    units.ts               nm <-> mm, rounding, formatting
    geometry.ts            polygon kernel facade (Phase 0 picks the kernel)
    canonical.ts           canonical JSON serialization + SHA-256 hash
    status.ts              the eight terminal statuses
    snapshot.ts            BoardSnapshot, run directory, immutability
    kicad/
      import.ts            .kicad_pcb/.kicad_pro/.kicad_dru -> PcbDesign
      export.ts            candidate -> .kicad_pcb by text surgery
      copper.ts            segment/via emission, strip, uuid derivation
      zones.ts             refill through kicad-cli, fill extraction
      version.ts           format-version pin and checks
  engines/                 P2/P3  contracts, registry, runner, wrappers
    contracts.ts           PlacerPlugin, RouterPlugin, CheckerPlugin
    manifest.ts            manifest schema + validation
    registry.ts            discovery, eligibility, policy
    runner.ts              single/race/staged/ensemble, isolation
    process.ts             out-of-process job protocol
    budget.ts              engine-second accounting
    routers/
      freerouting/         adapter.ts, dsn.ts, ses.ts
      kicad-tools/         adapter.ts (drives `kct route`; strategy per job)
      reference/           adapter.ts, grid.ts (harnessOnly)
    placers/
      fixed/               adapter.ts
      pyplacer/            adapter.ts
      kicad-tools/         adapter.ts (`kct placement optimize`, `kct optimize-placement`)
      layout-reuse/        adapter.ts, anchors.ts
      reference/           adapter.ts (harnessOnly)
  verify/                  P1/P2/P3/P4  checkers, diagnostics, scoring
    diagnostic.ts          Diagnostic, codes registry
    checkers/
      geometry.ts          bounds, intersections, invalid objects
      connectivity.ts      opens, shorts, membership, continuity
      kicad-drc.ts         kicad-cli DRC -> Diagnostic
      kicad-tools-drc.ts   kct drc --format json -> Diagnostic
      kicad-happy.ts       kicad-happy rules -> Diagnostic
      intent.ts            registry constraints -> Diagnostic (P4)
      routability.ts       fixed-router probe (P3)
      preflight.ts         RFC §10.6 pre-flight input checks
    gates.ts               hard placement and routing gates
    profiles/              fabrication profiles (JSON) + loader
    metrics.ts             placement and routing metrics
    scoring.ts             ranking, Pareto, profiles
  agent/                   P4/P5  the model-facing half
    constraints.ts         layout constraint classes (registry ext.)
    ecad.ts                netclass/.kicad_dru/lock/keepout ingestion
    intent/
      language.ts          intent YAML schema + parser
      compiler.ts          the seven-step compiler
      physics.ts           current-width, impedance HOLD
    repair/
      catalog.ts           actions with cost estimates
      planner.ts           diagnostics -> action within budget
    evidence.ts            evidence bundle writer + LAYOUT.md renderer
    orchestrate.ts         pcb layout: the closed loop
engines/                   out-of-process wrapper material (not TS)
  pyplacer/                                   (vendored at a pinned commit, one patch)
  README.md                                   (kicad-tools and Freerouting are user-installed: `kct`, jar)
bench/                     P2+  copperbench
  golden/                  microboards with expected diagnostics
  suites/                  suite definitions (JSON)
  corpora/                 acquisition scripts, never the boards
  runner.ts, report.ts, compare.ts, cli.ts
  reports/                 committed milestone reports (B0..B4)
```

**Import direction** (P1, enforced by `test/pcb-imports.test.ts`): `ir` imports nothing under `src/pcb/`; `verify` imports `ir`; `engines` imports `ir` and `verify/diagnostic`; `agent` imports `ir`, `verify`, `engines/contracts`, `engines/registry`, `engines/runner`, never a wrapper under `engines/routers/` or `engines/placers/`; `src/commands/check.ts` reaches `verify` and `ir` only. The test walks `import` statements the same way `test/init-check.test.ts` walks `check.ts` today.

**Packages later.** The directories above are the RFC §14.1 units. When they split into packages, only `package.json` files and import paths change.

## 2. Statuses and errors (P1)

`src/pcb/ir/status.ts`:

```ts
export type LayoutStatus =
  | 'PASS' | 'PARTIAL' | 'HOLD' | 'REFUSE' | 'UNSUPPORTED'
  | 'TIMEOUT' | 'ENGINE_ERROR' | 'INVALID_OUTPUT';

export interface Outcome {
  status: LayoutStatus;
  /** One line a human reads first. */
  summary: string;
  /** PARTIAL: what remains. HOLD: what is needed. REFUSE/UNSUPPORTED: why. */
  detail: string[];
  /** Diagnostics that produced this outcome, when any. */
  diagnostics: Diagnostic[];
}
```

Mapping onto the agent loop: `PASS`/`PARTIAL` complete a stage; `HOLD` halts `create` with a resume hint and is the `finish({outcome: 'refuse'})` path in `do` with the HOLD detail as the summary; `REFUSE` is the existing refusal path; the remaining four are stage failures with the status as the failure class. Every CLI command exits 0 on `PASS`/`PARTIAL`, 2 on `HOLD`, 3 on `REFUSE`, 4 on `UNSUPPORTED`, 5 on `TIMEOUT`, 6 on `ENGINE_ERROR`, 7 on `INVALID_OUTPUT`; usage errors keep exit 1.

Engine-side failures are typed: `class EngineError extends Error { kind: 'no-binary' | 'no-runtime' | 'runtime-too-old' | 'timeout' | 'process-failed' | 'declined' | 'no-output' | 'malformed-output' | 'empty-result' | 'schema-mismatch' }`, each carrying a `fix` string. `declined` is an engine refusing the board on its own rule (kct's auto-grid coarser than clearance/2); a board every engine declines is UNSUPPORTED, not ENGINE_ERROR. `runtime-too-old` is detected from `UnsupportedClassVersionError` in Java output *(verified: Freerouting 2.4.1 needs a JRE 25, 2.2.4 a JRE 21)*.

## 3. The IR (P1)

### 3.1 Types

`src/pcb/ir/types.ts`, all lengths in integer nanometres (`Nm = number`), angles in millidegrees (`Mdeg = number`), positive rotation counter-clockwise in a Y-down frame (KiCad's convention, so no conversion at the adapter).

```ts
export type Nm = number;
export type Mdeg = number;
export interface Point { x: Nm; y: Nm }
export interface Polygon { outer: Point[]; holes: Point[][] }

export interface PcbDesign {
  schemaVersion: '1.0';
  designId: string;                 // uuidv5(project path + board uuid)
  source: SourceProvenance;         // files, kicad version, import time
  board: BoardDefinition;
  components: ComponentInstance[];
  nets: NetDefinition[];
  constraints: ConstraintRef[];     // { id, registryPath }
  placement?: PlacementState;
  routing?: RoutingState;
  /** KiCad constructs the adapter recognised but does not model, kept verbatim. */
  preserved: PreservedBlock[];
  /** Fields a lossy import could not recover (RFC §6.1). */
  lossy: string[];
}

export interface BoardDefinition {
  outline: Polygon;                 // Edge.Cuts, one closed loop (pre-flight refuses otherwise)
  cutouts: Polygon[];
  layers: LayerDefinition[];        // { id, name, kind: 'copper'|'silk'|'mask'|'paste'|'courtyard'|'fab'|'edge'|'user', side?: 'front'|'back' }
  thicknessNm?: Nm;
  keepouts: Keepout[];              // { id, polygon, layers, prohibits: ('tracks'|'vias'|'pads'|'footprints'|'copper')[] }
  fabricationProfile: string;       // profile id, default 'jlcpcb-2layer'
}

export interface ComponentInstance {
  id: string;                       // stable: the footprint's KiCad uuid
  reference: string;
  value: string;
  footprint: FootprintDefinition;   // { libId, courtyard: Polygon|null, body: Polygon|null, attributes }
  pads: PadDefinition[];
  attributes: { side: 'front'|'back'; locked: boolean; throughHole: boolean; excludeFromBom: boolean; dnp: boolean };
  semanticRoles: string[];          // filled by the intent compiler (P4); empty on import
}

export interface PadDefinition {
  id: string;                       // uuidv5(component id + pad number + ordinal)
  number: string;
  netId: string | null;
  shape: 'circle'|'rect'|'oval'|'roundrect'|'trapezoid'|'chamfered'|'custom';
  /** Absolute board position and absolute rotation (KiCad stores pad rotation absolute). */
  at: Point; rotation: Mdeg;
  size: { w: Nm; h: Nm };
  layers: string[];                 // layer ids
  drill?: { d: Nm; offset?: Point; slot?: { w: Nm; h: Nm } };
  /** Copper outline in board coordinates, computed at import for every shape. */
  copper: Polygon;
}

export interface NetDefinition { id: string; code: number; name: string; padIds: string[]; netClass: string }

export interface PlacementState {
  components: { id: string; at: Point; rotation: Mdeg; side: 'front'|'back' }[];
  lockedComponentIds: string[];
}

export interface RoutingState {
  segments: { id: string; netId: string; layer: string; a: Point; b: Point; width: Nm }[];
  arcs: { id: string; netId: string; layer: string; a: Point; mid: Point; b: Point; width: Nm }[];
  vias: { id: string; netId: string; at: Point; size: Nm; drill: Nm; layers: [string, string] }[];
  zones: CopperZone[];              // definition only; fills live in ZoneFill
}
export interface CopperZone { id: string; netId: string | null; layers: string[]; outline: Polygon; priority: number; clearance: Nm; thermal: { gap: Nm; bridge: Nm } | null; definitionText: string /* verbatim */ }
```

`ZoneFill { zoneId, layer, polygons: Polygon[] }` is derived data produced by 5.4, held beside the candidate, never inside `PcbDesign`.

### 3.2 Units and geometry

`units.ts`: `mmToNm(mm) = Math.round(mm * 1e6)`, `nmToMm(nm)` formats with at most six decimals trimmed (KiCad's own precision). `geometry.ts` exposes `union`, `intersects`, `distance`, `area`, `bbox`, `offset`, `contains` over `Polygon`, implemented on the kernel Phase 0 selects (candidates: `polygon-clipping`, `martinez-polygon-clipping`; both MIT). Nothing else in `src/pcb` imports the kernel directly.

### 3.3 Canonical serialization and hash

`canonical.ts`: keys sorted, arrays in declared order except where the type says "set" (then sorted by id), integers only, no whitespace, UTF-8. `hashDesign(design) = sha256(canonical(design without source.importedAt))`. `PcbDesign.source.contentHash` is that hash; every candidate, diagnostic, and report carries it.

### 3.4 Snapshot

```ts
export interface BoardSnapshot {
  schemaVersion: '1.0';
  hash: string;                     // hashDesign of `design`
  design: PcbDesign;
  scope: { kind: 'placement'; movableComponentIds: string[] } | { kind: 'routing'; netIds: string[] | null; region: Polygon | null; preserveExistingRoutes: boolean };
  hardConstraints: LayoutConstraint[];
  objectives: { metric: string; weight: number }[];
  seed: number;
  limits: { engineSeconds: number; wallSeconds: number; memoryMb: number };
  referenceMap: Record<string, string>;   // refdes -> component id
  preserved: { componentIds: string[]; netIds: string[] };
}
```

On disk (3.5) the snapshot is `snapshot.json` in the run directory, written once, then the directory's `snapshot.json` is opened read-only for every engine (`chmod 0444`; the runner also verifies the hash after every engine exits and reports `INVALID_OUTPUT` on any mismatch, which covers filesystems that ignore the mode).

### 3.5 Run directory

`.copperhead/runs/<ts>/layout/` (inside the existing run directory so transcripts and redaction apply):

```text
snapshot.json                 the BoardSnapshot (3.4)
source/                       read-only copy of the project files the snapshot came from
candidates/<engineId>-<n>/    one per engine invocation
  job.json                    the PlacementJob or RoutingJob as sent
  result.json                 the engine's result, normalized
  candidate.json              the full PcbDesign after applying the result
  candidate.kicad_pcb         exported board (5.3), zones refilled (5.4)
  diagnostics.json            every checker's Diagnostic[] (6.1)
  metrics.json                every metric (9.1)
  provenance.json             engine, versions, args, seed, timing, memory
  stdout.log / stderr.log     engine process output, redacted
ranking.json                  Pareto frontier + selected candidate + reason
outcome.json                  Outcome (2)
events.jsonl                  runner events (engine start/stop, checker_disagreement, repair actions)
board.svg                     the board the run ends with, findings marked: the selected candidate, else the first candidate, else the input; written on every outcome, REFUSE and TIMEOUT included
```

The bundle (11) is this directory plus `LAYOUT.md`'s generated section.

## 4. KiCad adapter (P1)

### 4.1 Version pin

`kicad/version.ts` pins KiCad major 10 *(verified: 10.0.4 on the reference machine; `kicad-cli pcb drc` offers `--refill-zones`, `--save-board`, `--schematic-parity`, `--severity-*`)*. Import accepts board file versions from `20240108` (KiCad 8) through the current 10.x value; a newer `(version …)` returns `UNSUPPORTED`. `doctor` reports the mismatch through the existing `kicadCheck`.

### 4.2 Import

`kicad/import.ts` extends the read-only reader in `src/kicad/sexp.ts` with board-side accessors (closes #8): `listFootprints`, `listBoardNets`, `boardOutline`, `boardCopper`, `boardZones`, `boardLayers`, `boardSetup`. Rules of the read:

- Footprint absolute pad position: `origin + R(rot) · local` in KiCad's Y-down frame, `x' = x·cos θ + y·sin θ`, `y' = −x·sin θ + y·cos θ`; back-side pads are stored unmirrored in local coordinates *(verified against `pcbnew` on the StickHub demo for front −90° and back 45° parts)*. Pad rotation in the file is absolute; the pad's own rotation is `pad.rot − fp.rot`.
- Pad copper polygon per shape: circle (32-gon), rect, oval (stadium), roundrect (`roundrect_rratio`), chamfered, trapezoid (`rect_delta`), custom (`primitives`), all rotated into board space.
- Courtyard from `F.CrtYd`/`B.CrtYd` graphics; `null` when absent (pre-flight refuses).
- Outline: `gr_line`/`gr_arc`/`gr_rect`/`gr_circle`/`gr_poly` on `Edge.Cuts`, chained into loops with a 1 µm join tolerance; exactly one outer loop, other loops become cutouts.
- Nets from the `(net n "name")` table when the file has one (KiCad 8/9), otherwise discovered from `(net "name")` on pads, copper, and zones (KiCad 10.0.4's `20260206` format has no table and no codes; ADR 0004); `source.netDialect` records which, and copper emission follows it. Net class from `.kicad_pro` `net_settings.classes[].nets` or the netclass patterns, default `Default`.
- The project's `rule_severities` are read into `rules.severities`; the geometry and pre-flight checkers lower their own severity for `courtyards_overlap` and `missing_courtyard` to match (a designer who set a rule to ignore has made an ECAD-authored decision, RFC 11 §7.5). Footprints with no copper (logos, plain holes) owe no courtyard; footprints with copper and no courtyard get the pad extent as a stand-in so overlap is still checked.
- A footprint whose copper is inside the outline but whose courtyard overhangs it (edge connectors) is `geom.overhang` (warning), not `geom.outside-board`.
- Design rules: `.kicad_pro` `board.design_settings.rules` (min clearance, track width, via size, copper-edge clearance) and `net_settings.classes[]`; `.kicad_dru` rules parsed to a list of `{name, condition, constraint}` records handed to `ecad.ts` (8.2), never evaluated by the adapter itself.
- Zones: definition text captured verbatim (`definitionText`) plus the modelled fields; existing `filled_polygon` blocks discarded (they are derived).
- Everything else at board level (`gr_text`, dimensions, groups, images, `embedded_files`, unknown records) goes to `preserved[]` as verbatim text with its position in the file, so export can re-emit it unchanged.
- Locked footprints (`(locked yes)`) populate `PlacementState.lockedComponentIds`.

`lossy[]` records: a pad shape the polygoniser approximates (custom primitives with arcs), a zone the modeller cannot represent (rule areas with unknown flags), an `Edge.Cuts` set that does not close.

### 4.3 Export

`kicad/export.ts` never serializes the IR. It takes the immutable source copy and applies a candidate by text surgery, block-aware (paren matching on the `(footprint …)`, `(segment …)`, `(via …)`, `(arc …)`, `(zone …)` blocks):

1. For each component whose placement changed: replace the block's first top-level `(at x y [rot])`, and its `(layer "F.Cu"|"B.Cu")` when the side changed (a side flip also rewrites every `F.`/`B.` layer token inside the block, the same mapping KiCad applies).
2. Remove every `(segment …)`, `(arc …)`, `(via …)` block whose id is not in the candidate's preserved set (routing scope with `preserveExistingRoutes: true` keeps them all); append the candidate's copper (4.4) before the closing paren.
3. Zone blocks are re-emitted from `definitionText`; `filled_polygon` blocks are dropped (refill follows, 5.4 and 4.5).
4. `preserved[]` blocks are re-emitted verbatim in their original order.
5. `(generator "copperhead-pcb")` and `(generator_version "<copperhead version>")` replace the header's generator pair.

The export is deterministic: same source, same candidate, same bytes. `test/pcb-roundtrip.test.ts` proves the identity case (import → export with no candidate → byte-identical except the generator pair) on the fixture repo, the reference boards, and the KiCad demo projects present on the machine.

### 4.4 Copper emission

`kicad/copper.ts`, KiCad's own record layout:

```text
    (segment
        (start 143.69 85.34)
        (end 143.81 85.22)
        (width 0.15)
        (layer "F.Cu")
        (net 1)
        (uuid "…")
    )
    (via
        (at 157.25 102.45)
        (size 0.5)
        (drill 0.3)
        (layers "F.Cu" "B.Cu")
        (net 1)
        (uuid "…")
    )
```

UUIDs: `uuidv5('copper/<netName>/<layer>/<i>', designNamespace)` using the existing `uuidv5` in `src/kicad/emit.ts`; `knum` from the same module formats numbers. Net codes come from the candidate's net table.

### 4.5 Zone refill

`kicad/zones.ts`: `refill(pcbPath)` runs `kicad-cli pcb drc --refill-zones --save-board --format json --output <tmp> <pcb>` *(verified flags)*; the DRC report it produces is the KiCad DRC checker's input (6.3), so one process does both. `extractFills(pcbText)` reads the saved `filled_polygon` blocks into `ZoneFill[]` for the connectivity and return-path checkers. The `pcbnew.ZONE_FILLER` route is not used at runtime; it stays available as an oracle in a gated test.

### 4.6 Board population

`src/kicad/board.ts` (from `feat/board-bootstrap`) is the adapter's schematic-to-board input stage and moves to `src/pcb/ir/kicad/populate.ts` unchanged in behaviour: netlist export, footprint resolution order, instantiation, pad nets, load probe. Its shelf pack becomes `placers/reference` (harnessOnly). The stamp it writes becomes `copperhead-pcb`.

## 5. Verification (P1, intent checker P4, probe P3)

### 5.1 Diagnostics

```ts
export interface Diagnostic {
  code: string;                              // 'conn.short', 'drc.clearance', 'intent.attachment.distance' …
  category: 'geometry'|'connectivity'|'drc'|'intent'|'quality';
  severity: 'error'|'warning'|'info';
  entityIds: string[];
  entityReferences: string[];                // refdes / net names / pad numbers
  region?: Polygon;
  measured?: { value: number; unit: 'nm'|'mdeg'|'count'|'ratio'|'nm2' };
  allowed?: { value: number; unit: string; relation: '<='|'>='|'=='|'!=' };
  message: string;
  suggestedActions: RepairActionType[];      // 10.1
  sourceChecker: { id: string; version: string };
}
```

`diagnostic.ts` also holds the code registry: a table of every code with its category, default severity, and the gate it feeds (5.5). Adding a code is a one-line table change plus a golden microboard that exercises it (12.2).

Checker result states follow RFC 6: `CheckResult { status: 'PASS'|'FAIL'|'WARN'|'UNKNOWN'|'NOT_APPLICABLE'|'BLOCKED'; diagnostics; metrics; evidence }`.

### 5.2 Checker plugin

```ts
export interface CheckerPlugin {
  manifest(): Promise<CheckerManifest>;      // id, version, license, executionMode, networkRequirement, domains: string[]
  check(candidate: CandidateSnapshot): Promise<CheckResult>;
}
export interface CandidateSnapshot { snapshot: BoardSnapshot; design: PcbDesign; fills: ZoneFill[]; pcbPath: string; profile: FabricationProfile }
```

Built-in checkers are library-mode TypeScript; kicad-tools DRC and kicad-happy are process-mode wrappers (7.4).

### 5.3 Checkers

- **geometry** (`geometry.ts`): every pad, segment, via, and fill inside the outline minus copper-edge clearance (`geom.outside-board`); segment length > 0 and width ≥ profile minimum (`geom.degenerate`, `geom.width`); via layers are a copper pair (`geom.via-layers`); no object on a layer the board lacks (`geom.unknown-layer`); courtyard overlap between components (`geom.courtyard-overlap`, region = the intersection).
- **connectivity** (`connectivity.ts`): union-find over pads, segments, arcs, vias, and zone fills, joined by polygon intersection on a shared copper layer (vias join their two layers). Every net with more than one pad forms exactly one component: otherwise `conn.open` (naming the pad groups). Any union that spans two nets is `conn.short` (naming both nets and the touching objects). Copper on net X touching a pad of net Y is the same code. Net ties are honoured through the `(net_tie_pad_groups …)` footprint attribute *(KiCad 8+)*, so a tie is not a short.
- **kicad-drc** (`kicad-drc.ts`): the JSON report from 4.5 through `normalizeReport`; each violation becomes `drc.<type>` with the item positions as `region` (a 0.1 mm square at each item) and severity from the report; `unconnected_items` become `conn.unrouted` info-severity diagnostics with the count in metrics, never errors; `schematic_parity` entries become `preflight.parity`.
- **kicad-tools-drc** (`kicad-tools-drc.ts`, P1, optional): `kct check <pcb> --format json --mfr <profile.kicadToolsMfr>` *(verified: `kct drc` only parses an existing report; `kct check` is the pure-Python checker; kicad-tools 0.20.0, MIT)*; `violations[]` fields `rule_id`, `type`, `severity`, `message`, `location`, `layer`, `actual_value`, `required_value`, `items`, `nets` map onto `Diagnostic` as `drc.kct.<rule_id>` at the reported severity, except `connectivity`, which becomes `quality.kct.connectivity` (warning) because it disagrees with KiCad on zone-connected nets (ADR 0002); missing `kct` yields `NOT_APPLICABLE` with the install hint, never a failure.
- **kicad-happy** (`kicad-happy.ts`, P1, optional): same shape; rule ids prefixed `quality.happy.<rule>`, always `warning` or `info`.
- **preflight** (`preflight.ts`): the RFC §10.6 pre-flight list; runs once on the snapshot and returns `REFUSE` with the offending refdes or net: parity (`kicad-cli pcb drc --schematic-parity` when a schematic is configured), pad count versus symbol pins (from `list_symbols` + the footprint), unconnected pins without no-connect (ERC report), net ties, missing courtyard, THT annular ring against the profile, exactly one closed outline, no keepout on `Edge.Cuts`.
- **intent** (`intent.ts`, P4): one evaluator per constraint class (8.1), each producing `intent.<class>.<parameter>` diagnostics with `measured`/`allowed`; `hard` severity → error, `soft` → warning, `advisory` → info. The `functional.group` evaluator measures each block's spread (the maximum member-centroid-to-anchor-centroid distance) against the block's budget and its region containment; `functional.separation` measures the minimum courtyard-to-courtyard distance between two blocks; `relative.attached` measures pad-to-pad distance between the support part and the named pins.
- **return-path** (`returnpath.ts`, P2, two-layer only): from the zone fills and bottom-layer segments: `quality.pour.fragments` (connected components of the ground fill), `quality.pour.largest-share`, `quality.bottom-signal-length-nm`, `quality.pour.crossing` (a signal segment on the top layer whose projection crosses a fill gap; error for nets tagged `sensitive`, metric otherwise), `quality.stitching` (advisory, via count within 5 mm of each connector).
- **routability** (`routability.ts`, P3): runs `router-freerouting` in a fixed configuration (`passes: 10`, default rules) on a placement candidate in its own sub-run directory and reports `quality.routability.completion` (ratio) and `quality.routability.drc-errors` (count) as metrics, never as gates.

### 5.4 Authority and disagreement

`gates.ts` owns the domain table: `drc.*` codes from KiCad win over the same measurement from kicad-tools; profile limits (5.6) win over KiCad's project settings when stricter; `intent.*` and `conn.*` are copperhead's. When two checkers disagree on a hard fact (one `error`, the other `PASS` for the same object and rule domain) the runner records `checker_disagreement` in `events.jsonl` and the candidate's outcome is `HOLD` with both diagnostics.

### 5.5 Gates

`placementGates(diags)` fails on any error-severity `geom.courtyard-overlap`, `geom.outside-board`, `intent.mechanical.*` (fixed, edge, orientation), `intent.manufacturing.keepout`, `preflight.*`, or `intent.electrical-layout.creepage`. `routingGates(diags, profile)` fails on `conn.short`, `conn.open` for mandatory nets, `geom.*` errors, `drc.<type>` errors whose `<type>` is in `profile.criticalDrc`, `intent.routing.width` for nets tagged critical. Unrouted connections never gate (they are `PARTIAL`).

### 5.6 Fabrication profiles

`verify/profiles/jlcpcb-2layer.json` (P0 vendors from kicad-tools with its upstream commit in `source`):

```json
{
  "id": "jlcpcb-2layer",
  "source": { "project": "kicad-tools", "commit": "<pinned>", "path": "…" },
  "layers": 2,
  "minTrackNm": 127000, "minClearanceNm": 127000,
  "minViaDrillNm": 300000, "minViaDiameterNm": 500000, "minAnnularNm": 100000,
  "copperEdgeClearanceNm": 300000,
  "viaInPad": "forbidden",
  "criticalDrc": ["clearance", "shorting_items", "track_width", "via_diameter", "via_hole", "hole_clearance", "edge_clearance", "courtyards_overlap", "copper_edge_clearance", "items_not_allowed"],
  "advisoryDrc": ["lib_footprint_mismatch", "silk_over_copper", "silk_overlap", "text_height", "text_thickness"],
  "kicadToolsMfr": "jlcpcb"
}
```

`criticalDrc` is the definition of a critical DRC violation (RFC Appendix C.2 item 5): membership in this list.

## 6. Engines (P2 routers, P3 placers)

### 6.1 Manifest

`engines/manifest.ts` validates `manifest.json` against the schema generated from:

```ts
export interface EngineManifest {
  id: string; kind: 'placer'|'router'|'checker';
  version: string; adapterVersion: string; license: string;   // SPDX
  inputSchemaVersions: string[]; outputSchemaVersions: string[];
  determinism: 'deterministic'|'seeded'|'nondeterministic';
  executionMode: 'library'|'process'|'container'|'remote';
  networkRequirement: 'none'|'optional'|'required';
  harnessOnly: boolean;
  requires: { binaries?: string[]; env?: string[]; python?: string; java?: string };
  capabilities: PlacerCapabilities | RouterCapabilities | CheckerCapabilities;   // RFC §8.1 / §9.1 / §10.1
  supportedConstraints: string[];                                                // constraint class[.parameter]
}
```

JSON Schemas for manifests, jobs, and results are generated into `schemas/pcb/*.schema.json` by `npm run schemas` (P2) from the TypeScript types using `ts-json-schema-generator`, committed, and validated in a test so they never drift.

### 6.2 Contracts

`engines/contracts.ts` carries `PlacerPlugin`, `RouterPlugin`, `CheckerPlugin`, `PlacementJob`, `PlacementResult`, `RoutingJob`, `RoutingResult` exactly as RFC §8.1 and §9.1, with `Diagnostic` from 5.1 and coordinates in `Nm`. A library-mode plugin implements the interface in TypeScript; a process-mode plugin is a directory with `manifest.json` and an executable `run` and is driven by `process.ts`.

### 6.3 Process protocol

For `executionMode: 'process'`: the runner creates `candidates/<id>-<n>/`, writes `job.json` (the job, including a *copy* of `snapshot.json`'s design and a path to the read-only source copy), then spawns `run --job job.json --out result.json` with `cwd` set to that directory, environment scrubbed to `PATH`, `HOME`, `LANG`, `JAVA_HOME`, `PYTHONPATH`, `KICAD*`, and the engine's declared `requires.env`, never any variable ending in `_KEY` or `_TOKEN`. The engine writes `result.json` (schema-validated on read) and may stream progress as NDJSON on stdout (`{"event":"progress","fraction":0.4,"note":"…"}`); stderr is captured. Timeout: `limits.wallSeconds`; on expiry the process group is killed and the result is `TIMEOUT`. Peak memory from `/usr/bin/time -v` when present, else omitted.

### 6.4 Registry and eligibility

`registry.ts` discovers: built-in library plugins (imported statically), then `engines/*/manifest.json` in the copperhead install, then `.copperhead/engines/*/manifest.json` in the repo, then `COPPERHEAD_PCB_ENGINES` (colon-separated directories). Later entries with the same id override earlier ones. `eligible(engine, job, policy)` returns `{ ok: true }` or `{ ok: false, reasons: string[] }` checking, in order: kind, schema versions, `harnessOnly` (unless `policy.allowHarnessEngines`), every hard constraint's class in `supportedConstraints`, layer count, via types, license against `policy.licenses` (default: allow all SPDX identifiers, deny none, but `GPL-*` and `AGPL-*` require `executionMode !== 'library'`), `networkRequirement` against `policy.network` (`'none'` on the `check` path, `'optional'` in `create`/`do`, `'required'` only when config `pcb.allowRemoteEngines` is true), `requires` present. An ineligible set for a job is `UNSUPPORTED` with the union of reasons.

### 6.5 Runner

`runner.ts` executes a job on eligible engines under one of:

- `single`: the first eligible engine in the requested order.
- `race`: all eligible engines concurrently, up to `pcb.maxParallelEngines` (default: CPU count / 2); every finished candidate is verified; losers are cancelled through `cancel()` when the winner is a `PASS` and the policy says `raceStopOnPass` (default false, so the benchmark sees every candidate).
- `staged`: an ordered list of `{ engine, scope }` steps; each step's candidate is the next step's preserved geometry (for example: route power nets with engine A, then the rest with engine B).

The default placement plan (RFC §8.5) is a `staged` plan the orchestrator builds itself: (1) `placer-fixed` over every component with a `mechanical.fixed`/`edge` constraint and every locked one; (2) `placer-anchors` (library, deterministic, P3): one anchor per block placed at its region's centroid in signal-flow order (input-side connectors' blocks first, output-side last, power entry beside its connector); (3) `placer-attach` (library, deterministic, P3): rule placement of `relative.attached` parts at their target pins, `placer-layout-reuse` for blocks carrying a `topology: datasheet_reference`; (4) the configured wrapped placer over the remainder with stages 1 to 3 locked; (5) the routability probe. A wrapped placer whose manifest declares `relativeConstraints` ⊇ `['grouped','region']` may be given stages 2 to 4 in one job; the checker verifies either way. `placer-anchors` and `placer-attach` are deterministic rule steps, not engines that compete, and are exempt from the harnessOnly rule because they place only what a constraint already fixes.

The default routing plan (RFC §9.5) is likewise `staged`: (1) power and ground nets, widths from the physics compiler or the user, with the ground pour preserved; (2) nets tagged `critical`/`sensitive` under their own constraints; (3) the rest by `race` over the configured routers. Layer preference (bottom disfavoured for signals, preferred direction per layer) is passed as `routing.layer` constraints; `router-freerouting` maps them to its layer `(type signal|power)` and preferred-direction settings, other engines declare support or return unsupported for that stage.
- `ensemble`: every engine, then ranking picks per 9.3.

Every invocation records `provenance.json` and an `events.jsonl` line; `budget.ts` charges wall-clock and engine-seconds per invocation and refuses to start an engine whose `estimate()` (when provided) exceeds the remainder.

### 6.6 Router wrappers

**router-freerouting** (`routers/freerouting/`, process mode, GPL-3.0, `networkRequirement: none`). Discovery: `COPPERHEAD_FREEROUTING_JAR`, then `pcb.freeroutingJar`, then the newest `freerouting-*.jar` under `~/.local/share/kicad/*/3rdparty/plugins/*/jar/` (Linux), `~/Library/Preferences/kicad/*/3rdparty/plugins/*/jar/` (macOS), `%APPDATA%/kicad/*/3rdparty/plugins/*/jar/` (Windows). Java: `COPPERHEAD_JAVA`, `$JAVA_HOME/bin/java`, `java` on PATH; version probed once. Invocation: `java -jar <jar> -de <dsn> -do <ses> -mp <passes> [-oit <optimizeIgnoreTime>]`, `passes` from `pcb.freerouting.passes` (default 20). `dsn.ts` emits Specctra from the snapshot and `ses.ts` parses the session; the conventions, all *(verified)* against `pcbnew.ExportSpecctraDSN` and a real Freerouting 2.4.1 run:

- `(resolution um 10)` and `(unit um)`; coordinates in micrometres (nm / 1000), Y negated.
- `(place REF x y front rot)` with KiCad's rotation for front parts; back parts use `180 + rot`.
- One `(image …)` per distinct footprint geometry (lib id plus `::n` when instances differ); pins in footprint-local coordinates, Y negated; padstacks interned by geometry, named after KiCad (`Round[T]Pad_<d>_um`, `RoundRect[T]Pad_<w>x<h>_<r>_um_<rot>_0`), polygons for non-round shapes with the pad's rotation relative to its footprint baked in, `[A]` for through-hole on both copper layers.
- Boundary from the outline polygon inset by the profile's copper-edge clearance; `(rule (width …) (clearance …))` from the snapshot's design rules; one `kicad_default` class listing every net with `use_via`; per-netclass classes when the ECAD netclasses differ.
- Copper layer names are the board's own (the ecc83 demo names them `top_cu`/`bottom_cu` and the session echoes that).
- Session coordinates are resolution units: 10 000 per mm for `um 10`; `(path LAYER width x y …)` becomes segments per consecutive pair; `(via PADSTACK x y)` becomes a via with size and drill from the padstack name; an unknown layer is `malformed-output`.
- Existing copper is emitted under `(wiring …)` only when `preserveExistingRoutes` is true.

**router-kicad-tools** (`routers/kicad-tools/`, process mode, MIT). Invokes `kct route <in.kicad_pcb> -o <out.kicad_pcb> --strategy <basic|negotiated|monte-carlo|evolutionary> --trace-width --clearance --via-drill --via-diameter [--nets …] [--preserve-existing] --timeout <s> --skip-drc` on the board the adapter exported, re-imports the output, and diffs copper against the input to build the result *(verified on ecc83: 19/20 connections, 0 KiCad DRC errors, 18 s; ADR 0002)*. `router-kicad-tools-astar` in the RFC is this wrapper with `--strategy basic`. `requires.binaries: ["kct"]`, pinned `kicad-tools==0.20.0`.

**router-reference** (`routers/reference/`, library mode, `harnessOnly: true`): Lee/A* on a 0.25 mm grid, two layers, vias at grid points, no push-and-shove. Exists so the harness has a deterministic router in CI; ineligible for production jobs.

**router-pcbworld-pns** (deferred, P6): PCBWorld-Engine exposes KiCad 9.0.8's push-and-shove router over a unix socket under GPL-3.0; it fits `executionMode: process` and would be the third bulk router. Not in this change.

### 6.7 Placer wrappers

**placer-fixed** (library): returns the input placement; the control.

**placer-pyplacer** (`placers/pyplacer/`, process mode, BSD-3-Clause, Python 3.10+, stdlib only). Vendored at commit `34baa02` under `engines/pyplacer/` with one patch: the fixed-component prefix test (`kicad_pcb.py:45`, refdes `J` and `H`) becomes a `--fixed <ref,…>` argument so `lockedComponentIds` are honoured. Needs numpy. The wrapper exports the snapshot to a temporary `.kicad_pcb` (4.3), runs `python3 run.py in.kicad_pcb out.kicad_pcb --seed <seed> --iterations <n> --cooling <c> --fixed …`, re-imports the output, and returns the placement *(verified on ecc83: placed in 11 s, but 16 courtyard overlaps and 10 THT-in-courtyard errors, so its candidates routinely fail the placement gates; ADR 0008)*. `determinism: seeded`; `capabilities.rotation: false` (upstream disables rotation moves), `bottomSide: false`.

**placer-kicad-tools-physics** / **placer-kicad-tools-evolutionary** (`placers/kicad-tools/`, process mode, MIT): `kct placement optimize <pcb> -o <out> --strategy force-directed|evolutionary --fixed <refs> [--constraints …] [--keepout …] --format json`. **placer-kicad-tools-cmaes**: `kct optimize-placement <pcb> -o <out> --strategy cmaes --seed current|force-directed --time-budget <s>` (needs the `placement` extra). Same export/re-import shape as pyplacer (ADR 0002, ADR 0008).

**placer-layout-reuse** (`placers/layout-reuse/`, library): given `pcb.layoutBlocks` entries `{ id, source: <path to a .kicad_pcb>, anchor: <refdes>, members: [<refdes>…] }`, copies the relative placement of each member around the anchor into the target with a rigid transform (translation + rotation), leaving non-members to a second placer in a `staged` plan.

**placer-reference** (library, `harnessOnly`): the shelf pack from `board.ts`.

## 7. Constraints and intent (P4; registry fields P1 so imports can write them)

### 7.1 Registry extension

`src/memory/constraints.ts` `Constraint` gains optional fields, additive, ignored by the existing electrical paths:

```ts
export interface LayoutFields {
  class: 'mechanical'|'relative'|'electrical-layout'|'functional'|'thermal'|'emc'|'manufacturing'|'routing'|'stackup';
  severity: 'hard'|'soft'|'advisory';
  scope: { refs?: string[]; roles?: string[]; nets?: string[]; pins?: string[] };
  parameters: Record<string, number | string | boolean | string[]>;   // units in the key: max_distance_nm, min_width_nm
  priority: number;
  confidence: number;                 // 0..1
  approvedBy?: string;                // 'user' | 'ecad_rules' | run id
}
```

Keys follow the existing dotted convention: `layout.relative.C12-near-U1`, `layout.routing.class.Power.width`. `record_constraint` accepts the new fields; `check` treats an entry with `class` as a claim the intent checker validates (5.3), and the drift check ignores it.

### 7.2 ECAD ingestion

`agent/ecad.ts` (runs at every import): netclass → `layout.routing.class.<name>.{width,clearance,via_size,via_drill,diff_pair_gap}` (hard, `source: ecad_rules`, `confidence: 1`); `.kicad_dru` rule → `layout.routing.dru.<name>` carrying the raw condition and constraint (hard; evaluated by the KiCad DRC checker, not re-implemented); `(locked yes)` footprint → `layout.mechanical.fixed.<ref>`; keepout rule areas → `layout.manufacturing.keepout.<id>`. Ingested entries are replaced wholesale on the next import (never hand-edited); a derived entry that contradicts one is written with `severity: 'hard'` untouched and the run's outcome is `HOLD` naming both.

### 7.2a Functional blocks

`src/pcb/intent/blocks.ts` (P3; the deterministic part lives outside `agent/` because the staged placement plan in `engines/place.ts` consumes it and engines never import agent): `deriveBlocks({ design, subsystemsMd, schematicIntent })` reads `docs/SUBSYSTEMS.md` headings and the `group` field per part in `schematic.intent.json` (the same partition the schematic engine draws as group boxes), maps refdes to component ids, and emits one `layout.functional.group.<slug>` constraint per subsystem with `parameters: { anchor: <id>, members: [<id>…], region: <Polygon|null>, spread_budget_nm }`. Anchor: the block's IC (≥ 8 pads and not a connector) with the most member connections, else the largest courtyard. Region: assigned by signal flow, computed as a slot in a left-to-right (or connector-to-connector) ordering of blocks weighted by their connections to edge connectors; null when no connector constrains it. Spread budget: `1.5 · sqrt(sum of member courtyard areas)`. Parts without a subsystem go to an `unassigned` block that carries no region and a diagnostic. The compiler's model call may only add roles or propose a split/merge with a justification string; each accepted change is written as its own constraint with `source: intent-compiler` and `confidence` from the model's stated confidence.

### 7.2b Reference layout retrieval

`src/pcb/intent/references.ts` (P3 for the local sources; the datasheet source and the network sources are P4 and live under `agent/` because they call a model) implements RFC §8.6. Entry point `findReferences(design, blocks, opts) → ReferenceBlock[]`, exposed as the `pcb_find_references` tool (11.3) and run by `pcb layout` before the attachment stage.

Sources, each behind a `ReferenceSource` interface (`id`, `kind: 'datasheet'|'design'|'teardown'`, `network: boolean`, `search(query) → Candidate[]`, `extract(candidate) → ReferenceBlock`):

- `datasheet`: for every anchor part, the cached datasheet under `.copperhead/datasheets/` (from `add-part-research-tools`; `fetch_datasheet` when absent). Text rules ("place C_IN within 2 mm of VIN") are extracted deterministically by the fact-base parser into attachment constraints with the page cited; the reference-layout figure, when one exists, is read by one model call that returns the relative arrangement as a `ReferenceBlock` with `confidence ≤ 0.6` and the figure's page as source.
- `design`: native `.kicad_pcb` files. Local: the KiCad demo projects on the machine, the PCBench clone, `manual-tests/reference-boards`, and every path in `pcb.referenceDesigns`. Online (P4): GitHub code search through the `web_search` client for `.kicad_pcb` files containing the anchor's MPN, footprint id, or symbol lib id, cloned shallowly into `var/refs/` at the commit found. Each hit is imported through 4.2 and cut to the block: the anchor plus every component sharing a net with it within 15 mm, plus the segments and vias among them.
- `teardown`: RFC 1 teardown outputs (`placement-analysis.yaml`, `circuit-patterns.yaml`) from `pcb.teardownCorpus` directories; a pattern whose components map onto the anchor's roles becomes a block with the teardown's stated placement findings as attachment constraints.

```ts
export interface ReferenceBlock {
  id: string;                                   // uuidv5(source + anchor)
  source: { kind: 'datasheet'|'design'|'teardown'; locator: string; commit?: string; retrieved: string; contentHash: string; license: string | 'unknown' };
  anchor: { role: string; mpn?: string; footprint?: string; libId?: string };
  members: { role: string; footprint?: string; value?: string; rel: { x: Nm; y: Nm; rotation: Mdeg }; side: 'front'|'back' }[];
  edges: { fromRole: string; fromPad: string; toRole: string; toPad: string; net: string }[];
  routing?: { segments: RoutingState['segments']; vias: RoutingState['vias'] };   // relative to the anchor
  rules: { text: string; constraint: LayoutFields & { key: string } }[];     // stated distances, widths
  similarity: { score: number; mpn: boolean; family: boolean; footprint: boolean; pattern: boolean; connectors: number; boardClass: boolean };
  confidence: number;
  approvedBy?: string;
}
```

Similarity: `score = 1.0·mpn | 0.7·(family ∧ footprint) | 0.5·pattern`, plus `0.1·min(connectors, 3)/3` and `0.1·boardClass`, capped at 1; ties broken by source authority (datasheet > teardown > design). Role mapping from a block's members to the design's components uses the compiler's semantic roles (7.2a) and net topology (the block's `edges` must embed in the design's netlist around the anchor); an unmapped member is dropped and noted.

Cache: `.copperhead/layout-refs/<id>.json` (committed, like the datasheet cache) plus `index.json` with `{ id, anchor, score, license, approvedBy }` rows; a run reads the cache first and searches only for anchors without a cached block or when `--refresh-references` is passed. Network sources are logged in the transcript's network-request section.

License policy (`agent/intent/licenses.ts`): `permissive = ['MIT','BSD-2-Clause','BSD-3-Clause','Apache-2.0','CC0-1.0','CC-BY-4.0','CERN-OHL-P-2.0','Unlicense','TAPR-OHL']` apply automatically; `'CERN-OHL-S-2.0','CERN-OHL-W-2.0','GPL-*','LGPL-*','CC-BY-SA-*','unknown'` require approval: the block is cached with `approvedBy` unset, the run returns `HOLD` naming the block and its license, and `pcb_find_references { approve: [id] }` or the CLI `--approve-reference <id>` records the approver. Datasheet figures are treated as `permissive` for the purpose of placement rules (facts are not copyrightable) and their source is cited.

Application: an approved block with the best score per anchor becomes `relative.attached` constraints (one per member, `max_distance_nm` from the block's relative distance plus 10%) and a `functional.group` topology hint `datasheet_reference`/`design:<id>`, each with `source: layout-refs/<id>.json`; `placer-layout-reuse` then places the members by the block's `rel` transform around the anchor in stage 3 of the staged plan, and the intent checker verifies the result. The evidence bundle's per-subsystem table names the reused block and its source.

### 7.3 Intent language

`agent/intent/language.ts` parses the RFC §7.3 YAML (`docs/LAYOUT.intent.yaml`, path configurable) into constraint entries: `placement.fixed[]` → mechanical (`edge`, `orientation`, `at`), `attachments[]` → relative `attached` (`target.ref`, `target.pins`, `max_distance_nm`), `groups[]` → functional `group` (`members`, `topology`), `separation[]` → functional `separation` (`groups`, `min_nm`), `keepouts[]` → manufacturing `keepout`, `routing.priorities[]` → routing `priority`. Unknown keys are `HOLD`, not ignored.

### 7.4 Compiler

`agent/intent/compiler.ts` runs the seven RFC §7.4 steps. Steps 1 and 3 are the only model calls (through the existing provider abstraction, tool-gated): step 1 asks for block and role assignment as JSON validated against `{ roles: Record<ref, string[]>; blocks: { id, members }[] }`; step 3 asks for candidate rules as intent YAML and cites the fact-base entry (RFC 4 dossier or datasheet cache) for each. Steps 2, 4 to 7 are deterministic. Output: the constraint entries written to the registry plus `intent-report.md` in the run directory (the human-readable explanation).

### 7.5 Physics compiler

`agent/intent/physics.ts`: `widthForCurrent(amps, copperOzFt2, riseC, layer: 'external'|'internal')` from an IPC-2152 table vendored as JSON (advisory unless `profile.copperWeight`, the constraint's `rise_c`, and the layer are all present, in which case it emits a hard `layout.routing.width` entry marked `derived_by: 'physics/ipc2152'`); `impedance(...)` always returns `HOLD` in this change (no validated stackup class instance exists yet).

## 8. Scoring (P2 routing, P3 placement)

### 8.1 Metrics

`verify/metrics.ts` computes, per candidate, a flat `Record<string, number>`:

- routing: `completion_rate`, `unrouted_count`, `drc_error_count`, `drc_warning_count`, `total_wirelength_nm`, `via_count`, `bend_count` (direction changes per net), `acute_angle_count` (< 90° between consecutive segments), `layer_transition_count`, `runtime_s`, `peak_memory_mb`; the PCBWorld-protocol set is pinned by the Phase 0 teardown and computed by the same module under `pcbworld.*` keys so track B reports match its definitions.
- placement: `intent_compliance` (weighted fraction of applicable hard and soft constraints satisfied), `routability_completion`, `routability_drc_errors` (from 5.3's probe), `congestion_overflow` (2 mm cells with estimated demand above capacity), `critical_attachment_nm` (sum over attachment constraints of pad-to-pad distance), `block_spread_ratio` (mean over blocks of spread / budget), `blocks_over_budget`, `hpwl_nm`, `runtime_s`.
- two-layer quality (both stages): `pour_fragments`, `pour_largest_share`, `bottom_signal_length_nm`, `pour_crossings`, `stitching_vias_per_connector`; the default scoring profile weights `pour_largest_share` and `bottom_signal_length_nm` ahead of `total_wirelength_nm`.

### 8.2 Profiles and ranking

`verify/profiles/scoring/default-low-speed-2-layer.json` carries `gates` and `weights` per RFC §11.3. `scoring.ts`: candidates failing a gate are marked ineligible with the gate named; eligible ones are sorted lexicographically by (`completion_rate` desc, `intent_hard_violations` asc, `intent_soft_violations` asc); the Pareto frontier over the profile's weighted metrics is computed on the remaining ties; the profile's weighted sum picks `selected`. `ranking.json` records every candidate with `eligible`, `gateFailed`, `pareto`, `score`, and the `reason` string.

## 9. Repair loop (P5)

### 9.1 Catalog

```ts
export type RepairActionType =
  | 'continue-routing' | 'change-net-priority' | 'select-router' | 'tune-router' | 'rip-up-nets'
  | 'move-group' | 'resize-region' | 'rotate-component' | 'use-ranked-candidate'
  | 'request-user-action';
```

`repair/catalog.ts` gives each action its parameter schema and a cost estimator `(job, action) => { engineSeconds, wallSeconds }` (a routing rerun estimates from the last routing run's provenance; a placement action adds a routing rerun).

### 9.2 Planner

`repair/planner.ts` takes `{ diagnostics, ranking, budgetRemaining, history }` and asks the model (one tool-gated call, JSON-validated) for one action from the catalog whose estimate fits; a hard-constraint relaxation is not an action and can only surface as `request-user-action` → `HOLD`. The loop in `orchestrate.ts` applies the action, re-runs the affected stage, re-verifies, and stops on the RFC §12.5 conditions.

## 10. Evidence bundle and LAYOUT.md (P5; bundle files from P2)

`agent/evidence.ts` writes the run directory of 3.5 and renders `## Draft quality` in `docs/LAYOUT.md` between `<!-- copperhead:layout-evidence:start -->` and `…:end -->` markers from `ranking.json`, `outcome.json`, and the selected candidate's diagnostics and metrics: status line, satisfied and unsatisfied constraints (by registry key with measured/allowed), a per-subsystem table (block, anchor, spread against budget, unsatisfied attachments, unrouted connections with a pin in the block), the two-layer return-path metrics, unrouted connections by net, engines run (id, version, seed, runtime, result), selected candidate and reason, fabrication profile, and the bundle path and snapshot hash. The fab gate's freshness check (add-fab-release-gate D4) reads `snapshot.hash` here.

## 11. Surfaces

### 11.1 CLI (`src/cli.ts`, `pcb` group; P2 onward)

| Command | Flags | Model? | Writes |
|---|---|---|---|
| `pcb import [--project <path>]` | `--json` | no | `snapshot.json`, ingested ECAD constraints |
| `pcb infer-intent` | `--intent <yaml>`, `--json` | yes | registry entries, `intent-report.md` |
| `pcb place` | `--placers <ids>`, `--mode`, `--seed`, `--profile`, `--json` | no | candidates, ranking |
| `pcb route` | `--routers <ids>`, `--mode`, `--nets`, `--preserve`, `--seed`, `--profile`, `--allow-harness-engines`, `--json` | no | candidates, ranking |
| `pcb verify <pcb>` | `--profile`, `--json` | no | diagnostics only |
| `pcb score <run-dir>` | `--scoring <profile>`, `--json` | no | `ranking.json` |
| `pcb layout` | `--profile`, `--budget-seconds`, `--placers`, `--routers`, `--mode`, `--json` | yes | everything, plus `LAYOUT.md` and the selected board written to the configured board path |

Exit codes per 2. `--json` prints `outcome.json` merged with `{ runDir, ranking }`. `import`, `verify`, `score`, `place`, and `route` are LLM-free and network-free; `place` and `route` refuse any engine with `networkRequirement: required`.

`copperbench` is a second bin in `package.json` (`src/bench/cli.ts`, built to `dist/bench/cli.js`): `run --track <e|d|f|a|b|c> --suite <name> [--engines …] [--seeds …]`, `compare <a> <b>`, `report <dir>`.

### 11.2 Config (`.copperhead/config.json`, `pcb` block)

```json
"pcb": {
  "profile": "jlcpcb-2layer",
  "scoring": "default-low-speed-2-layer",
  "placers": ["pyplacer", "kicad-tools-physics"],
  "routers": ["freerouting", "kicad-tools-astar"],
  "mode": "race",
  "budgetSeconds": 900,
  "maxParallelEngines": 2,
  "freeroutingJar": null,
  "freerouting": { "passes": 20 },
  "allowRemoteEngines": false,
  "intentPath": "docs/LAYOUT.intent.yaml",
  "layoutBlocks": [],
  "plan": { "placement": "staged-default", "routing": "staged-default" },
  "referenceDesigns": [],
  "teardownCorpus": [],
  "referenceSearch": { "online": true, "maxPerAnchor": 5 }
}
```

Unknown keys are ignored; every key has the default shown. Documented in the generated `.copperhead/README.md` beside `legibility`.

### 11.3 Agent tools (`src/agent/tools.ts`; P4/P5)

- `pcb_find_references` `{ refs?: string[], subsystems?: string[], refresh?: boolean, approve?: string[] }` → searches the sources of 7.2b for the named anchors (default: every block anchor), writes the cache, returns per anchor the ranked blocks with score, source, license, and whether approval is needed. `requiresUnlock: false`; network use logged; absent on the `check` path.
- `pcb_infer_intent` `{ intent_yaml?: string }` → writes the YAML when given, runs the compiler, returns the constraint list with provenance and any HOLDs. `requiresUnlock: false` (it writes only the registry and a doc, through the existing dual-write obligation).
- `pcb_layout` `{ profile?: string, mode?: string }` → runs `orchestrate`, returns the outcome summary, engines run, selected candidate, unsatisfied constraints, bundle path; sets `ctx.lastDrc` from the selected candidate's KiCad DRC report and clears or opens the `drc` obligation accordingly; marks the board touched. `requiresUnlock: true`.
- `pcb_repair` `{ action: string, params: object }` → one catalog action within budget; refuses off-catalog actions listing the catalog. `requiresUnlock: true`.
- `edit_file` guard: on a `.kicad_pcb` whose generator is `copperhead-pcb`, a replacement whose `old_string` or `new_string` contains `(segment`, `(via`, `(arc`, or `(zone` is refused naming `pcb_repair`; footprint `(at …)` edits stay allowed and re-open the `drc` obligation as today.

### 11.4 Pipeline and check

`create` stage 5 (P5): before the model's first turn, `orchestrate` runs with `place: true` on a freshly populated board; the "Board as placed" block becomes the rendered evidence summary; the completion contract (create-pipeline delta) checks `outcome.status ∈ {PASS, PARTIAL}` and `snapshot.hash === hashDesign(import(board))`. `check` (P4): when `docs/LAYOUT.md` carries the evidence markers, run preflight, geometry, connectivity, KiCad DRC, and intent checkers on the committed board and print the layout track; no engine, no model. `do` (P5): a board with evidence markers routes through `pcb_repair`.

## 12. Benchmark (P2 onward)

### 12.1 Layout

```text
bench/
  golden/<case>/            board.kicad_pcb, board.kicad_pro, intent.yaml?, expected.json
  suites/microboards.json   { cases: [...], tracks: ['e','a','b'] }
  suites/pcbench-qual.json  { corpus: 'pcbench', ids: [...20], tracks: ['b'] }
  corpora/pcbench.sh        clones PCBench (MIT) into var/corpora/pcbench at a pinned commit
  corpora/pcbworld.md       protocol notes; nothing cloned (license, 12.3)
  reports/B0-<date>.md …    committed milestone reports
src/bench/                  runner.ts, report.ts, compare.ts, cli.ts (the bench code lives under src/ so tsc builds the second bin; bench/ holds only data)
```

`expected.json`: `{ "diagnostics": [{ "code": "conn.short", "entityReferences": ["GND", "+3V3"] }, …], "status": "REFUSE"|…, "metricsWithin": { "via_count": [0, 4] } }`. The B0 test asserts the exact code set and that no unexpected error appears.

### 12.2 Golden microboards (P0)

Ten boards, each hand-authored in KiCad 10 and committed with its project file, one seeded fault each: courtyard overlap; part outside the outline; fixed connector moved off its edge; decoupling capacitor 8 mm from its IC pins; keepout violation; an open on a mandatory net; a short between two nets; a clearance violation; incomplete routing; and a congestion case (a 2x18 header with every signal entering one channel). They grow to 40 in P2 along the RFC §13.3 categories.

### 12.3 Corpora and licenses *(verified 5 September 2026)*

- **PCBench** (github.com/PCBench/PCBench at `dec3be7`, repository MIT; per-board licenses in `metadata.json`, 605 of 1,183 unrecorded): `PCBs/<author>_<name>/{raw,processed}.kicad_pcb`, mostly KiCad 4 and 5 files. Cloned by `bench/corpora/pcbench.sh` at the pinned commit, never committed; only boards with a recorded permissive license enter any suite; boards are upgraded in place on a copy with `kicad-cli pcb upgrade --force` (no `--output` flag exists).
- **PCBWorld** (github.com/LGAI-Research/PCBWorld): the environment, agents, and evaluation code are under the PCBWorld License 1.0-NC, which also covers the software's *outputs*; the engine is GPL-3.0 in a separate repository; no datasets are distributed. Adopted: the metric definitions (CP, Rout., DRV in both counting modes, WL, Via, Time, Parse-fail) and the three-stage protocol; not adopted: Potential Gain (a function of their reward code), any code, any generated board, the D3 processed boards. Details and the comparability caveats in ADR 0001. PCBench is the real-board corpus: 1,183 boards, of which 181 are permissively licensed and two-layer, 177 upgrade with `kicad-cli pcb upgrade --force`, and 39 pass KiCad 10 DRC error-free (32 under 50 footprints); the qualification suite is 20 of those (ADR 0003, `bench/corpora/pcbench-drc-sweep.json`).
- **Cypress** (NVlabs): placement cases only where its license permits; decided in P0.

### 12.4 Runner and reports

`src/bench/runner.ts` executes a suite over the engines and seeds requested, through the same `orchestrate`/`runner` code paths as the CLI (never a bench-only path), writing `bench/var/runs/<ts>/` with per-board `outcome.json`, `metrics.json`, and a `summary.csv`; `report.ts` renders JSON and a self-contained HTML page with the RFC §13.4 record (versions, licenses, adopted-versus-built, reproduction command); `compare.ts` diffs two runs of the same benchmark version and refuses otherwise. Milestone reports B0 to B4 are `report.ts` output committed under `bench/reports/` with the claim they support.

## 13. Tests

- Unit (always): IR types and canonical hash stability; geometry facade; pad polygonisation against the pcbnew dump of StickHub committed as `test/fixtures/pcb/stickhub-pads.json` (positions only, no board text); DSN and SES fixtures captured from KiCad's exporter and Freerouting 2.4.1 on the synthetic test board; manifest validation; eligibility matrix; ranking; catalog cost estimates; intent YAML parsing; ECAD mapping; LAYOUT.md rendering.
- kicad-cli-gated (skips without `kicad-cli`, like `test/board-bootstrap.test.ts`): round trip on the fixture repo and reference boards; zone refill; KiCad DRC checker mapping; pre-flight refusals on the golden microboards; the B0 determinism test; `router-reference` end to end with DRC.
- Engine-gated (`COPPERHEAD_TEST_FREEROUTING=1` with jar and JRE; `COPPERHEAD_TEST_KICAD_TOOLS=1` with `kct`; `COPPERHEAD_TEST_PYPLACER=1`): each wrapper end to end on the synthetic board and one microboard, asserting the result schema, provenance fields, and that the source snapshot is untouched.
- Oracle (`COPPERHEAD_TEST_PCBNEW=1`): DSN emitter versus `pcbnew.ExportSpecctraDSN` (placement records, boundary extents, image pin counts, net pin sets); zone fill versus `pcbnew.ZONE_FILLER`.
- Guards (always): import direction (1); `check` module graph never reaches `src/pcb/engines/routers|placers` or `src/pcb/agent`; the network guard of `test/init-check.test.ts` extended to `pcb verify` and `pcb score`; every manifest in `engines/` validates; every schema in `schemas/pcb/` matches its generator output.
- Bench (nightly, not in the default `npm test`): `copperbench run --suite microboards --track e,a,b` with the reference engines; the B-milestone reports are regenerated and diffed.

## 14. Phase map

| Phase | Lands | Exit test |
|---|---|---|
| P0 | ADRs in `docs/adr/` (PCBWorld, kicad-tools, kernel, KiCad pin, contracts, critical DRC, profile, bench home); ten golden microboards; `bench/corpora/pcbench.sh` | golden cases pass `kicad-cli pcb drc` in CI |
| P1 | 2, 3, 4, 5.1 to 5.6 (except intent and probe), 7.1 fields, 6.1 manifest schema | round trip, seeded violations, hash stability, import-direction guard |
| P2 | 6.2 to 6.6 routers, 8.1 routing metrics, 8.2, 11.1 `import/route/verify/score`, 12.1, 12.4, B0 and B1 reports | B0 byte-stable, B1 selection regret zero |
| Checkpoint | ADR: proceed to P3 or ship the routing harness in stage 5 | published B1 report |
| P3 | 6.7 placers, 5.3 probe, 8.1 placement metrics, `pcb place`, B2 report | B2 and the §8.3 decision |
| P4 | 7.2 to 7.5, 5.3 intent checker, `pcb infer-intent`, `pcb_infer_intent`, `check` layout track, tracks E and F, B3 report | B3 |
| P5 | 9, 10, `pcb layout`, `pcb_layout`, `pcb_repair`, edit guard, stage 5 switch, `do` integration, tracks D and C, B4 (directional) | end to end unattended on supported boards |

## 15. Decisions this document makes that Phase 0 may revise

1. Polygon kernel: `polygon-clipping` unless the teardown finds a robustness problem on real boards.
2. Process protocol: files plus NDJSON progress (6.3), not a socket; a socket is what PCBWorld-Engine would need and can be added as a second transport when that wrapper lands.
3. pyplacer is vendored with a one-argument patch rather than forked.
4. `jlcpcb-2layer` values above are KiCad-defaults-shaped placeholders until the kicad-tools profile is vendored with its commit.
5. The PCBWorld protocol is adopted without its code (12.3); if the relicense lands, the teardown ADR may switch track B to the upstream evaluator for comparability.

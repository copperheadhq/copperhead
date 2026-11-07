# add-power-integrity-gate: Design

## Decisions

1. **External subprocess adapter & licensing**: Invokes `COPPERHEAD_KIPIDA_BIN` (default `ki-pida --json <board.kicad_pcb>`) as a separate OS process with `stdin: 'ignore'` and a 30s default timeout (`COPPERHEAD_KIPIDA_TIMEOUT_MS`). Like `ngspice` in `add-spice-verification-gate`, external power-integrity solvers (e.g. KiPI / padne / IPC Python wrappers emitting the documented JSON telemetry contract) are optional system dependencies and are never bundled or vendored.
2. **Fail-closed boundary validation**: `validatePidaTelemetry` rejects non-objects, unknown snake_case keys, non-array sections, missing/non-finite numeric fields, and empty `{}` payloads so malformed adapter output can never silently report `power-integrity ✓`.
3. **Skip-with-reason vs `--strict-power`**: Following the SPICE gate precedent, `check --power` reports `power-integrity skipped (...)` when the external binary is not installed, while `check --power --strict-power` fails the run. When telemetry arrives for a category with no `power.*` budget in `constraints.json`, the checker emits an explicit `power_budget_missing` warning rather than a silent pass.

## JSON telemetry contract (ki-pida adapter -> copperhead)

Decision 1 calls this "the documented JSON telemetry contract". Until now it
existed only as TypeScript interfaces in `src/kicad/pida.ts`, so an adapter
author had nothing to read. This section is that contract; it mirrors
`validatePidaTelemetry` exactly.

**Envelope.** A single JSON object. Top-level keys are limited to `rails`,
`currentDensity`, `thermal`, `dependencies`. **Any other top-level key is
rejected** — including a well-meaning `"version": 1`. All four keys are
optional, but see *Empty payloads* below.

**`rails[]`** — IR drop per sink.

| field | type | required |
|---|---|---|
| `rail` | non-empty string | yes |
| `sinkRef` | non-empty string | yes |
| `irDropV` | finite number (volts) | yes |
| `x`, `y` | finite number (board units) | optional |

**`currentDensity[]`** — current-density hotspots.

| field | type | required |
|---|---|---|
| `rail` | non-empty string | yes |
| `layer` | non-empty string | yes (e.g. `"F.Cu"`) |
| `currentDensityAmm2` | finite number (A/mm²) | yes |

**`thermal[]`** — temperature rise per component.

| field | type | required |
|---|---|---|
| `ref` | non-empty string | yes |
| `tempRiseC` | finite number (°C) | yes |

**`dependencies[]`** — rail power-up ordering.

| field | type | required |
|---|---|---|
| `rail` | non-empty string | yes |
| `dependsOn` | non-empty string | yes |
| `satisfied` | boolean | yes |

**Rejections.** Non-objects, arrays at the top level, unknown top-level keys,
snake_case key names, non-array sections, malformed entries, and non-finite or
missing numeric fields all raise `PidaToolError`. Numeric strings are **not**
coerced.

**Empty payloads (open question).** A payload holding no measurements in any
section is rejected. `{}` is rejected, and so is
`{"thermal":[],"currentDensity":[]}`. The second case is deliberate today but
surprising: a hotspot-only adapter would emit exactly that for a clean board,
and `check --power` would then exit 1 on a good design. Resolving it is a spec
decision, not a code fix — the plausible rule is to require only that the
producer emit the keys it actually analyzed (reject `{}`, accept
`{"thermal":[]}`). **Not changed in this PR**; raised for maintainer direction.

**Status of the fixture.** `test/fixtures/pida/sample-telemetry.json` is
hand-written. None of the tools named in Decision 1 (KiPI, padne, IPC Python
wrappers) is known to emit this shape, so no production adapter exists yet.

# add-pcb-placement: Proposal

This change puts placement on `main`, end to end, and connects it to the
records of copperhead RFC 11 version 1.4. It implements RFC 15, whose
reference implementation is the `src/pcb` tree (RFC 15 Section 1.4), and
builds on `add-pcb-ir` and `add-pcb-import`.

## Why

The layout harness and the reuse placer were built on
`feat/pcb-layout-framework`. That branch fell 109 commits behind `main` and
was never merged, so nobody could use placement. It also predates RFC 11
1.4, so a run's results were not the records that standard defines: no
placement diff, no placement.md, no ownership or approval.

## What Changes

- **The harness is ported onto `main`.** Ported as-is:
  - `src/pcb` (IR, engines, placers, routers, reuse, verify, intent)
  - the vendored packer and pyplacer
  - `schemas/pcb`
  - the `pcb` commands: import, route, place, plan, reuse, references,
    infer-intent, layout, verify, render, score
  - the framework's tests and fixtures, and its OpenSpec changes:
    `add-pcb-layout-framework`, `add-reuse-placer`,
    `add-multilayer-layout`, `fix-critical-drc-keys`

  `main`'s shared code keeps its behaviour:
  - **DRC report:** it keeps its shape and gains only `unroutedItems`. The
    harness's DRC checker separates warnings and footprint-internal
    findings itself.
  - **`copperhead check`:** it gains the layout track, which re-verifies
    a board whose `LAYOUT.md` carries layout evidence and is silent
    otherwise.
- **A reuse run speaks RFC 11:**
  - **Placement diffs:** each option's placement diff against the board
    as it was (Section 6.11) is written beside its board, as JSON and as
    the text view of Section 14.4.
  - **placement.md (Section 12.6):** written when the plan is validated
    and again when the run ends.
  - **Ownership:** the board is imported by `add-pcb-import`, so every
    part is owned by the import. Moving one needs approval (RFC 12
    Section 9.5); `--apply` is that approval.
- **Ranking follows RFC 15 Section 11.** The tiers run in the RFC's order:
  T1 mechanical, T2 datasheet-required placement, T3 antenna and thermal, T4
  critical routing, T5 loop area, T6 separation, T8 routability, T9 length.
  Each metric has its own direction and tolerance, relative where the RFC
  says so; a tier a candidate was not measured on ties. The framework's
  profile ranked loop area before critical routing, had no T2, and compared
  min-max normalised sums inside one tolerance. Each candidate's reason
  names the tier that put it ahead of the next.
- **Each option is an RFC 11 candidate** (Section 6.10), written as
  `candidate.json` beside its board, so its placement diff marks the moves
  that need approval.
- **One ranking decides.** After critical routing, the outcome,
  `ranking.json` and `outcome.json` are rebuilt from the final ranking, so
  what the run says it selected is what `--apply` writes. The ranking it
  replaced is kept as `ranking-before-critical.json`.
- **Critical routing covers RFC 15's top five,** not three.

## Not in This Change

- **The create pipeline's stage 5.** `create` does not yet run the
  harness, and its layout-draft stage does not ask for layout evidence.
  `main` rewrote `create.ts` after the framework branched, so this is its
  own change; two tests of that contract are skipped until it lands.
- **The agent's `pcb_layout` and `pcb_repair` tools.**
- **The plan record of RFC 15 Section 7.1.** A run writes its plan in
  the harness's own shape (`placement-plan.json`), not yet in
  `schemas/rfc15/plan.schema.json`.
- **Block layouts and layout operations** (RFC 11 Sections 6.10 and 6.12).
  The reuse run places by transfer and packing, so it writes none, and
  `--apply` writes the board file directly.
- **Moving the harness's internal IR onto the RFC 11 records.** The
  records are the run's boundary; the harness keeps its own IR inside.

## Capabilities

### Modified Capabilities

- `pcb-reuse-placer`: a run writes placement diffs and placement.md, and
  one ranking decides.
- `cli-surface`: `pcb reuse` names placement.md and reports what the
  selected option changes.

## Impact

- **Code:** `src/pcb`, `src/vendor`, `vendor/`, `schemas/pcb`,
  `src/commands/pcb-*.ts`, `src/kicad/board.ts`, and
  `src/pcb-ir/placement-md.ts`.
- **Additions to shared code:** `src/kicad/report.ts`
  (`unroutedItems`), `src/kicad/cli.ts` (DRC options), `src/config.ts`
  (`pcb` settings), `src/kicad/symlib.ts` (footprint hints),
  `src/memory/constraints.ts` (layout fields), and
  `src/commands/check.ts` (the layout track).
- **Dependencies:** `@flatten-js/core`, `polygon-clipping`, `yaml`, and
  `ts-json-schema-generator` for development.
- **SPEC.md:** AC-22, and the `pcb reuse` and `pcb place` surface.

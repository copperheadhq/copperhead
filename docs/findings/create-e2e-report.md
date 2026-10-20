# End-to-End `copperhead create` Pipeline Findings Report (#66)

Legend: **BLOCKER** / **DEFECT** / **INEFFICIENCY** / **NOTE**
Priority: **P0** (blocks pipeline completion) to **P3** (ergonomic or test hardening)

## 1. Findings Grounded in Source and Pipeline Runs

### [BLOCKER] [P0] Stage 5 `move_footprint` could not position `Reference` text in board coordinates (#380)

- **Where:** `src/kicad/populate.ts` (`moveFootprint`, `rewriteRefAt`), `src/capabilities/index.ts`, `src/capabilities/handlers.ts`
- **Symptom:** KiCad stores footprint `Reference` `(at dx dy rot)` in the footprint's local rotated frame. During stage 5 (`layout-draft`), clearing silkscreen overlaps on rotated parts required hand-computing rotated local coordinates via `edit_file`.
- **Suggested:** Add optional board-coordinate `label_x` and `label_y` parameters to `move_footprint` and convert `(label_x - x, label_y - y)` into the footprint's local frame across `0`, `90`, `180`, and `270` degrees for both KiCad 8+ `(property "Reference" ...)` and legacy `(fp_text reference ...)`.
- **Status:** Fixed in PR #406 (`Closes #380`).

### [DEFECT] [P1] `copperhead review` wrote record skeleton before validating `--tools`, `--sweep`, `PATH`, and `--out` (#404)

- **Where:** `src/review/run.ts` (`emptyOrAbsent`, `runReview`), `src/review/tools-client.ts` (`resolveTools`)
- **Symptom:** Running `copperhead review` with a missing `--tools` path, an unpopulated `--sweep` directory, a file as `--out`, or `copperhead-tools` absent from `PATH` wrote `inputs.json` and `model/` before failing, causing identical reruns to fail with `--out ... is not empty`.
- **Suggested:** Validate `--out` (`ENOTDIR` vs `ENOENT`), `--sweep/review.json`, and `resolveTools` (including `env.PATH` executable lookup) before creating the output directory or writing `inputs.json`.
- **Status:** Fixed in PR #407 (`Closes #404`).

### [BLOCKER] [P0] Stage 7 (`firmware`) wedges on passive or breakout boards with no programmable MCU (#377)

- **Where:** `src/commands/create.ts` (`STAGES` entry for `firmware`, `dirHasFiles(path.join(root, 'firmware'), [...])`)
- **Symptom:** On a non-programmable brief such as `examples/simple/usb-c-breakout.md`, stage 7 requires a source file in `firmware/`, stalling completion unless a dummy source file is written.
- **Suggested:** Allow stage 7 to complete when `BOM.md` and `SUBSYSTEMS.md` declare no programmable part or when an explicit no-MCU marker is recorded.
- **Status:** Tracked in #377 (open PR #409).

### [DEFECT] [P1] `outputs/jlcpcb-bom.csv` emitted after stage 6 commit leaves working tree dirty for stage 7/resume (#379)

- **Where:** `src/commands/create.ts` (`emitJlcpcbAfterOutputs`)
- **Symptom:** `emitCreateJlcpcbBom` runs after the stage 6 commit, leaving `outputs/jlcpcb-bom.csv` uncommitted until the next resume sweeps it under `spec-seed`.
- **Suggested:** Emit `outputs/jlcpcb-bom.csv` before committing stage 6 so the outputs stage commit captures the full artifact set.
- **Status:** Tracked in #379 (open PR #396).

### [DEFECT] [P2] Stage 8 (`devplan`) completion check accepts a single heading and line written by an earlier stage (#378)

- **Where:** `src/commands/create.ts` (`STAGES` entry for `devplan`)
- **Symptom:** If stage 7 writes a short `"not compiled here"` note under a heading in `docs/DEVPLAN.md`, `devplan.isComplete` returns `true` and skips stage 8 without generating bring-up steps, test points, or prototype order plan.
- **Suggested:** Require a dedicated bring-up heading and substantive checklist items before marking `devplan` complete.
- **Status:** Tracked in #378 (open PR #387).

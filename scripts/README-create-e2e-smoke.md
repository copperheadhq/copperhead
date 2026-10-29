# Live create smoke

This opt-in script runs the real `create` CLI in a **new synthetic project**. It does not resume an existing project, replace a provider with a mock, or use a recorded success fixture. Its harness regression tests never call a model; the repository's separate provider integration tests retain their own opt-in rules.

The smoke can consume your existing provider quota or incur API charges. A wall-clock deadline and finite per-stage budgets limit the run; they are not a monetary spending cap. Use your own already configured provider and a public or synthetic brief. Never supply customer data or credentials in a brief.

From the checkout, with its existing dependencies, OpenSpec CLI, and KiCad installed:

```bash
# Safe default: prints SKIPPED; creates nothing and starts no CLI or model.
npx tsx scripts/create-e2e-smoke.ts --model codex

# Explicit live opt-in. This command can call the selected provider.
COPPERHEAD_LIVE_CREATE=1 npx tsx scripts/create-e2e-smoke.ts \
  --model codex \
  --brief examples/simple/rp2040-blinky.md \
  --timeout-ms 1800000 \
  --output-dir /tmp
```

`--model` is required for a live run. `--brief` defaults to the public RP2040 example. `--output-dir` must already exist; the script creates a unique child directory containing `project/` and `evidence/`, and never reuses or deletes an earlier run. The child CLI runs with the new project as its working directory, so it does not load the source checkout's `.env`. The script uses `src/cli.ts` through the local `tsx` loader and does not rebuild or overwrite `dist/`.

For [issue #66](https://github.com/copperheadhq/copperhead/issues/66), use the committed medium-complexity RP2040 sensor-interface brief, not the simple default. This is a command for a future live attempt, not a claimed successful recording:

```bash
COPPERHEAD_LIVE_CREATE=1 npx tsx scripts/create-e2e-smoke.ts \
  --model codex \
  --brief manual-tests/findings/issue-66/rp2040-sensor-interface.md \
  --timeout-ms 7200000 \
  --output-dir /tmp
```

KiCad must be on PATH, or supply `--kicad-cli /absolute/path/to/kicad-cli` (also supported: `COPPERHEAD_KICAD_CLI`). The selected binary is passed to both the real create subprocess and the independent checks. Single model turns have a ten-minute inactivity and hard cap; the overall CLI deadline remains controlled by `--timeout-ms`. The process-group watchdog supports macOS and Linux; it rejects Windows rather than pretending to terminate a whole process tree there. Timeout or interruption sends TERM, then KILL to the group, including provider descendants. Each independent KiCad check also has a deadline of at most two minutes.

The script exits with failure unless all of these are present:

- The actual CLI exits zero within its deadline.
- All eight stages have fresh `run-start`, `run-committed`, and terminal `run-end: done` events for this brief. The referenced commits must have the expected subjects, follow the initial commit in order, and remain ancestors of final HEAD. Archive commits are allowed. A fixed `stageCount: 8`, a resumed stage, or a dry-run `done` event is insufficient.
- The configured schematic has placed component instances and the board has populated footprints. Embedded symbol libraries and text containing `(footprint` do not count. Artifact paths must stay inside the synthetic project and cannot traverse symlinks.
- SPEC, SUBSYSTEMS, BOM, PINOUT, LAYOUT and DEVPLAN contain content; Gerber, drill, DXF, STEP, SVG and ordering CSV exports are nonempty; firmware has source and `pins.h`.
- Fresh, independent `kicad-cli` ERC and DRC processes succeed. DRC explicitly enables `--schematic-parity`. Their retained JSON reports identify the checked file and contain the expected empty violation arrays for errors and warnings. Missing reports, `{}`, unconnected items, or schematic parity violations fail.

Raw CLI stdout/stderr, native transcripts, commits and generated files stay on disk, including on failure. `evidence/result.json` records the outcome, process status, stage-to-commit mapping and artifact hashes; `erc.json` and `drc.json` are direct KiCad output. Inspect logs before sharing them. A pass proves this smoke's checks, not physical correctness, satisfaction of every brief requirement, or a successful firmware toolchain build. ERC/DRC still use the project's configured rules and exclusions.

Offline harness regressions use clearly labelled synthetic data and local child processes. They exercise missing final stages, false-green reports, empty designs, rejected runs and wedged process trees; they are **not evidence that a live eight-stage design succeeded**:

```bash
npx vitest run test/create-e2e-smoke.test.ts
```

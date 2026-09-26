# Issue 66: create pipeline findings

Status: work in progress, 2026-09-26. The real eight-stage acceptance run has
not passed. No hardware has been built or physically validated.

## Reproduction

The [brief](rp2040-sensor-interface.md) describes a USB-C-powered RP2040 sensor
interface with flash, power regulation, protection, SWD and an I2C header.
The first attempt used source `d5b262b`, KiCad 10.0.6, OpenSpec 1.13.2 and the
saved-login Codex provider. It returned exit 1 at `spec-seed`, with zero completed
stages and unchanged sandbox HEAD. Its [console log](attempt-01.log) is retained
with local workspace prefixes replaced by `<workspace>`.

```sh
bash manual-tests/setup.sh create
node dist/cli.js --repo manual-tests/runs/create --plain create \
  --brief manual-tests/findings/issue-66/rp2040-sensor-interface.md --model codex
```

The recorded first invocation used an external copy of the same brief. Its
SHA-256 is `4d6c9f17603aac3722faa3fd2b32691725ea03ea01835e40cccf09ffe11090a8`.
Use the existing sandbox to resume; do not hand-edit generated outputs or
reset it to manufacture a passing run.

## BLOCKER: proposal cannot satisfy its own gate

- **Priority:** P0.
- **Where:** `propose_change`, `validate_change` and the first create stage.
- **Symptom:** actual OpenSpec validation returned `Change must have at least
  one delta. No deltas found.` The proposal tool could only create proposal and
  task documents, while general editing stayed locked until validation.
- **Suggested:** allow named capability deltas through the proposal tool's fixed
  planning paths. Preserve the validation gate and keep arbitrary editing locked.
- **Status:** source fix and regression tests added. Real OpenSpec validates a
  supplied delta and rejects a malformed one. Re-proposing clears old editing
  authorization. Unsafe IDs, capability names and linked targets are rejected.
  A successful complete create run remains outstanding.

## DEFECT: failed resume commit advances the pipeline

- **Priority:** P1.
- **Where:** `commitResumedStage` in `src/commands/create.ts`.
- **Symptom:** a real rejecting pre-commit hook left HEAD unchanged, but create
  still included `spec-seed` in its completed list and entered the next stage.
- **Suggested:** return commit success/failure and stop before marking completion.
- **Status:** fixed and covered by failing-before/passing-after tests, including
  unrelated dirty work and a valid already-committed resume. Existing work stays
  intact when the commit fails.

## DEFECT: unsupported OpenSpec initialization is ignored

- **Priority:** P1.
- **Where:** `openspecInit` and `runCreate`.
- **Symptom:** actual OpenSpec 1.13.2 rejects `init --no-interactive`; create
  previously ignored the failed initialization and continued.
- **Suggested:** use `init --tools none` and stop with the original diagnostic
  before invoking a model if initialization fails.
- **Status:** fixed. The actual CLI initialized a fresh directory successfully;
  a real EACCES probe exited 1 without changing its brief, config, notes or HEAD.
  Existing workspaces retain their previous skip behavior, not an integrity check.

## DEFECT: fixed test schematic drifts against an installed library

- **Priority:** P2.
- **Where:** `test/fixtures/open-key`, real ERC in three existing tests.
- **Symptom:** KiCad 10.0.6 emitted two `lib_symbol_mismatch` warnings for `Device:R`.
  The same three test failures occurred on original base `c9045af`.
- **Suggested:** resolve the fixed resistor through a project-local library.
- **Status:** fixed with the already-embedded resistor and a local symbol table.
  Circuit geometry, nets, values and the warning policy are unchanged. Real
  ERC/DRC report zero violations. Changing a temporary library pin number still
  produces two mismatch warnings and exit 5.

## NOTE: current cache does not prove offline replay

- **Priority:** P2.
- **Where:** `response-cache.ts`, create recovery diagnosis and provider failover.
- **Symptom:** cache misses or corrupt entries call the live provider; recovery
  diagnosis is outside this cache. The first actual failure invoked diagnosis.
- **Suggested:** record full provider requests and responses for both paths,
  then replay with no constructed live provider and strict mismatch failures.
- **Status:** not implemented. No synthetic successful fixture is claimed.

## DEFECT: installed one-letter symbols are reported missing

- **Priority:** P1.
- **Where:** `searchInstalledSymbols` and `rankSymbolNames`.
- **Symptom:** the real part-selection run returned no matches for `R`, `C`,
  `Device:R` and `Device:C`, while `symbol_pins` resolved both devices with two
  pins. The tool then incorrectly declared those parts uncapturable.
- **Suggested:** allow single-character exact matches and accept a `Lib:Name`
  query without restricting discovery to a guessed library.
- **Status:** reproduced against the installed official KiCad 10.0.6 libraries.
  Source repair and exact-match/tool-dispatch regressions are included; single
  letters still do not trigger broad prefix or substring matching.

## BLOCKER: schematic capture lacks design evidence

- **Priority:** P1.
- **Where:** real attempt 02, transition from part selection to schematic capture.
- **Symptom:** the run committed `spec-seed`, `architecture` and `part-selection`,
  then refused schematic capture. Its generated requirements make RP2040 boot
  and pin-mux evidence, switch pin semantics, exact footprints and current bounds
  prerequisites. The part-selection stage left those facts unverified.
- **Suggested:** supply verified component and power-state evidence through the
  normal design workflow before capture. Do not remove the gate, invent device
  data or hand-edit generated artifacts to obtain an apparent success.
- **Status:** unresolved. The process exited 1, with three actual stage commits
  independently checked as ancestors of its final HEAD. ERC and DRC did not run.
  [Console log](attempt-02.log) and [stage evidence](attempt-02.json) preserve the
  failure. A symbol-search fix alone does not resolve the missing electrical
  evidence, and rerunning unchanged inputs is not a recovery.

## Validation and remaining acceptance

After the source, fixture and smoke-harness repairs: 1,047 tests passed, 21 tests skipped
(19 agent-integration, one conditional Claude Code provider and one local
real-design corpus test). Typecheck, CLI build, Markdown lint and phase-1 OpenSpec validation
passed. Three explicitly enabled real OpenSpec tests are included in that count.
The package has `lint:md`; it has no `npm run lint` script.

The [opt-in live smoke](../../../scripts/README-create-e2e-smoke.md) now runs a
fresh synthetic project and verifies eight ordered stage commits, nonempty
artifacts, and fresh ERC/DRC reports with schematic parity enabled. Its 24
offline harness regressions pass, including process-group timeout cleanup,
missing final stages, empty designs and malformed reports. The actual default
invocation prints SKIPPED without starting a model; the inspector rejects
attempt 02's real nonzero exit. These checks do not establish a successful live run.

Still required for issue 66:

- A real exit 0 with successful stage commits for all eight stages, ending in
  `devplan`, using this medium-complexity brief.
- Nonempty schematic/netlist/board evidence, genuine ERC/DRC reports, exported
  files and a DEVPLAN that states compiler and physical-validation limits.
- Execute the explicit live-smoke command on the complete generated design and
  retain a passing result; no successful complete live-smoke record exists yet.

The summary's `stageCount: 8` is a configured total, not proof of completion.
Full local transcripts and cached turns from the failed attempt are retained;
a successful-run evidence package will be added only when that run exists.

A later [native documentation correction](u2-correction.md) repaired the U2
footprint mapping using manufacturer evidence. The separate `do` run exited 0,
preserved the original failed sandbox and retained all 18 existing constraints.
It created no hardware and adds no completed `create` stage; the power and
full-pipeline requirements above remain pending.

Implementation and testing used Codex assistance.

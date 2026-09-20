# Recorded e2e replay fixture (`create` pipeline)

`test/create-e2e-replay.test.ts` replays a recorded end-to-end `copperhead
create` run — all eight stages, real tool execution, real ERC/DRC — against the
committed response cache in `test/fixtures/create-e2e/`. It is a gated job:
`COPPERHEAD_E2E_REPLAY=1` plus the pinned tool versions in
`test/fixtures/create-e2e/manifest.json`.

## Why replay instead of mocks

The pipeline's contract is behavioural: stage prompts, tool schemas, file side
effects, ERC/DRC gating, drift checks and per-stage commits have to agree. A
mocked `runAgentLoop` (see `test/create-resilience.test.ts`) verifies stage
orchestration; it cannot detect that a prompt edit broke the model's ability to
finish a stage, or that a tool-result format change invalidated every recorded
turn. The replay fixture makes those changes fail loudly: every cached turn is
keyed on `{model, baseURL, messages, tool names}`, so a request the recording
never made is a cache miss — and the recorded `baseURL`
(`http://127.0.0.1:11435`) is deliberately dead, so a miss ends the stage with a
provider error instead of silently calling a model.

Re-recording is only needed when a change intentionally alters what the model
sees (prompt text, tool schemas, tool result formats).

## Determinism inputs

Everything the model can observe during the run is pinned:

| Source | Pin |
| --- | --- |
| provider responses | recorded cache (`llm-cache/`), keyed per turn |
| `Date` | vitest `setSystemTime(manifest.recordedAt)` — docs embed date stamps that feed back into prompts |
| KiCad footprints | `HOME` → fixture dir with the recorded `fp-lib-table` |
| KiCad symbols | `KICAD_SYMBOL_DIR` → `symbols.txt` names the recorded libs; the test copies them from the machine's own KiCad install (contents identical — kicad-cli version is pinned) |
| repo path | fixed `/tmp/ch-e2e-repo` — tool error strings embed absolute paths |
| openspec CLI | `validate_change`/`archive` subprocess output; version pinned in the manifest |

## Recording a new fixture

On a machine with `kicad-cli`, `kicad-footprints` and `openspec` installed:

```bash
# 0. use `ch-e2e-*` path names — NEVER `copperhead-*`: the I8 startup sweep
#    (sweepStaleTempDirs) deletes every `copperhead-*` dir under tmpdir, and
#    its tests run it against a synthetic future clock that ages everything.
# 1. dead-port proxy in front of the real endpoint so the recorded baseURL
#    is unusable at replay time
socat TCP-LISTEN:11435,fork,reuseaddr TCP:127.0.0.1:11434 &   # 11434 = ollama

# 2. recording env
mkdir -p /tmp/ch-e2e-home/.config/kicad/10.0
cp /usr/share/kicad/template/fp-lib-table \
   /tmp/ch-e2e-home/.config/kicad/10.0/fp-lib-table   # CI-parity: no sym-lib-table
mkdir /tmp/ch-e2e-symbols
# copy the recorded lib set (fixture symbols.txt) out of the system install
xargs -a test/fixtures/create-e2e/symbols.txt -I{} \
  cp /usr/share/kicad/symbols/{} /tmp/ch-e2e-symbols/
mkdir /tmp/ch-e2e-repo && cd /tmp/ch-e2e-repo
git init -q .
cp test/fixtures/create-e2e/brief.md .
printf '.env\n.copperhead/runs/\n' > .gitignore
cp test/fixtures/create-e2e/config.json .copperhead/config.json
git add -A && git commit -qm baseline

# 3. record — write the log OUTSIDE the repo (search tools see repo files)
env HOME=/tmp/ch-e2e-home \
    COPPERHEAD_BASE_URL=http://127.0.0.1:11435/v1 \
    KICAD_SYMBOL_DIR=/tmp/ch-e2e-symbols \
    copperhead --repo /tmp/ch-e2e-repo create --brief brief.md --model compat:<model> > /tmp/run.log 2>&1
# (pass --repo rather than relying on cwd: process.cwd() resolves symlinks,
#  which would bake the target path — not /tmp/... — into recorded messages)

# 4. assemble the fixture — cache entries, symbol list, manifest
cp -r .copperhead/llm-cache test/fixtures/create-e2e/llm-cache   # drop its .gitignore
ls /tmp/ch-e2e-symbols/*.kicad_sym | xargs -n1 basename \
  > test/fixtures/create-e2e/symbols.txt
#    fill manifest.json: recordedAt, model, baseURL, kicadCliVersion,
#    openspecVersion, expectedStages, expectedOk, stageCommitSubjects,
#    wedgedStage, lastStageKeys
```

`lastStageKeys` is the set of cache keys written during `manifest.wedgedStage`
(usually the last completed stage); the wedge test deletes them so that stage
hits the dead endpoint and the run must report failure instead of passing
with a missing stage. For a partial recording (a run cut short), set
`expectedStages` to the stages that committed and `expectedOk: false` — the
replay then reproduces the recorded prefix and asserts the run ends on the
first cache miss.

`openspec/` is normally left out of the fixture: `openspecInit` recreates it
deterministically at run start (pinned openspec version). If a recording was
made against a build where init ran differently, ship the recorded
`openspec/` tree and the test copies it in verbatim instead.

## Running the replay

```bash
COPPERHEAD_E2E_REPLAY=1 npx vitest run test/create-e2e-replay.test.ts
```

The first test asserts the environment matches the manifest (kicad-cli and
openspec versions, dead endpoint). On this machine, stop the port-11435 proxy
before replaying or the dead-endpoint guard refuses to run.

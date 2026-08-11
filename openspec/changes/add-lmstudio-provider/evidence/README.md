# Live-run evidence — `--model lmstudio` (AC-3.21, AC-3.1, AC-3.7)

A real `copperhead do` run driven entirely by a local model, with **no cloud API key
in the environment**. This is the acceptance evidence for AC-3.21 and a live pass of
AC-3.1 (propagating rename) and AC-3.7 (surgical diff) on the local provider.

## Environment

| | |
|---|---|
| copperhead | v0.7.0 |
| Provider | `lmstudio` (endpoint `http://localhost:1234/v1`) |
| Server | LM Studio 0.4.19, `lms server start` |
| Model | `google/gemma-4-12b` — discovered by the provider, not named on the command line |
| kicad-cli | 10.0.4 |
| Runtime | node v22.23.1 · darwin-arm64 (Apple silicon) |
| Repo | `test/fixtures/open-key` + `copperhead init`, committed clean |

## Command

```sh
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  copperhead do "rename net KEY_DAH to KEY_DASH" --model lmstudio --plain
```

Both cloud API keys were **unset for the process**, so the run could not have reached a
cloud provider even by accident.

## Result

```
done · ERC clean · committed caa4d069a7 · 42s · 31.4k in / 788 out
```

10 turns, 42 seconds, one commit.

## What the run demonstrates

**No cloud key, no cloud call (AC-3.21).** The run completed with `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` removed from the environment. Nothing but `localhost:1234` was
contacted.

**Model discovery (D3).** The command said `--model lmstudio` with no model id. The
provider asked the server what was loaded and the run recorded the answer:

```
run … · model google/gemma-4-12b (lmstudio, via flag)
```

`transcript.jsonl`'s `run-start` event carries `"model":"google/gemma-4-12b"`,
`"provider":"lmstudio"` — so run metadata and the response-cache key identify the
actual model, not the routing string.

**Spec-gated-in, structurally (invariant 1).** Turns 2–3 show the model could not edit
anything until it wrote a proposal and validated it:

```
[turn 2] [propose_change] proposal written to openspec/changes/rename-key-dah-net/ — now call validate_change
[turn 3] [validate_change] validation passed; edit tools are now unlocked
```

The transcript records the `edit-tools-unlocked` event between them. Before it, the edit
tools were absent from the tool list sent to the local server.

**Verification-gated-out (invariant 2).** Turn 8 is the important one — the model tried
to finish after editing the schematic and was **refused**:

```
[turn 8] [finish] cannot finish yet:
         - ERC has not passed since the last schematic edit (run run_erc)
         - open sync obligations:
           - [erc] ERC must pass after schematic edits
```

It ran ERC at turn 9 and only then was allowed to finish. The gates apply to the local
provider exactly as to the keyed ones.

**Correct, surgical edit (AC-3.1, AC-3.7).** Both `global_label` occurrences in the
schematic and the `PINOUT.md` row were renamed; nothing else changed. No `KEY_DAH`
survives anywhere in `hardware/` or `docs/`.

```
-  (global_label "KEY_DAH" (shape input) (at 127 101.6 180) (fields_autoplaced yes)
+  (global_label "KEY_DASH" (shape input) (at 127 101.6 180) (fields_autoplaced yes)
-  (global_label "KEY_DAH" (shape input) (at 96.52 106.68 90) (fields_autoplaced yes)
+  (global_label "KEY_DASH" (shape input) (at 96.52 106.68 90) (fields_autoplaced yes)
-| U1 | 5 | GPIO14 | KEY_DAH | |
+| U1 | 5 | GPIO14 | KEY_DASH | |
```

2 changed lines in a 272-line schematic — **0.74%**, against AC-3.7's < 5% bound. The
file was edited in place, not regenerated.

**Redaction (AC-4.1).** `grep -rE 'sk-[A-Za-z0-9_-]+'` over the run artifacts and this
directory matches nothing. The pattern is deliberately the same one the runtime
redactor uses, with no minimum-length suffix: a `{20,}` variant would report clean
while a shorter `sk-` token survived.

Absolute install paths and the git author header have additionally been replaced with
`<REDACTED-…>` placeholders. Neither is evidence of anything; both are workstation
metadata that a committed artifact does not need to carry.

## Files

| File | What it is |
|---|---|
| `console.log` | Full terminal output of the run, verbatim |
| `transcript.jsonl` | The run's JSONL transcript (every turn, tool call, and result) |
| `summary.md` | The run summary copperhead wrote beside the transcript |
| `rename.diff` | The committed diff for the schematic and PINOUT.md |

## Reproducing

Requires LM Studio with a **tool-capable** model loaded (`google/gemma-4-12b` works;
models without function calling will not drive the loop).

```sh
lms server start                       # or LM Studio ▸ Developer ▸ Start Server
cp -R test/fixtures/open-key /tmp/proof && cd /tmp/proof
git init -q . && git add -A && git commit -qm fixture
copperhead init && git add -A && git commit -qm "init docs"
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  copperhead do "rename net KEY_DAH to KEY_DASH" --model lmstudio --plain
```

The gated integration suite covers the same ground:

```sh
COPPERHEAD_TEST_LMSTUDIO=1 npx vitest run test/agent-integration.test.ts
```

## Caveat

A single run on one 12B model. It establishes that the provider, discovery, gating, and
verification path work end to end on a local backend; it is not a claim about local-model
design quality in general, which varies by model. The safety gates are the backstop
either way — a weak local model produces a rolled-back run, not a broken board.

# Tasks: add-grounded-review

## 1. copperhead-tools client

- [x] 1.1 `src/review/tools-client.ts`: resolve `--tools`, `COPPERHEAD_TOOLS`, or `copperhead-tools` on PATH; `run <tool>` with the request on stdin; not-run and error results become errors
- [x] 1.2 Tests use an injected client; no test spawns copperhead-tools

## 2. Passes

- [x] 2.1 `src/review/prompts.ts`: rules, the bundle digest (parts, every net, the sweep, what it did not examine, sources), eight domain scopes; templates hashed
- [x] 2.2 `src/review/pass.ts`: query tools (parts, nets, pins, sweep, sources, search, read, board, placement, routing, measure, calculators, calc), `propose` with a `review-verify` pre-check, `submit`; domain-prefixed ids; turn, time and per-turn timeout budgets; sample saved every turn
- [x] 2.3 Tests: a pass with a scripted provider (queries, a pre-checked proposal, submit); stall and turn exhaustion with the warning

## 3. Run, record and replay

- [x] 3.1 `src/review/run.ts`: sweep (with `--fab` and `--fab-profile`), bundle (fab files as sources), parallel passes, merged proposals, verify, report, lockfile
- [x] 3.2 `--replay`: refuse changed proposals; re-verify into `replay/`; byte comparison
- [x] 3.3 Tests: a two-domain run never writes the design, records samples and the lockfile, and replays identically; tampered proposals are refused; `--out` inside the design or not empty is refused
- [x] 3.4 `--resume`: reuse sweep and bundle, keep ended passes, rerun the rest (an interrupted sample kept aside); a timed-out turn retried once; tests for both

## 4. CLI and protocol

- [x] 4.1 `copperhead review` in `src/cli.ts`, lazily imported
- [x] 4.2 Text tool protocol reads `arguments`, `parameters`, `input` and flat arguments; protocol tests
- [x] 4.3 SPEC.md section 3 gains the `review` command
- [x] 4.4 Run typecheck, the test suite, the build and `openspec validate add-grounded-review --strict`

## 5. Review fixes (PR #361)

- [x] 5.1 Redact pass summaries in `model/passes.json` and the progress lines; an `sk-` run glued to a word is a key only when long and holding a digit, so "mask-defined" quotations survive redaction verbatim
- [x] 5.2 Check `--out` against the design and every `--source` and `--fab` input through symbolic links
- [x] 5.3 Save the sample after a turn with no tool call and after a timed-out turn; write samples atomically; rerun a pass whose sample does not parse
- [x] 5.4 Refuse budgets that are not positive numbers before writing anything
- [x] 5.5 Inactivity watchdog and rate-limit backoff for pass turns; a specific nudge for a call written as an `<invoke>` block
- [x] 5.6 SIGINT and SIGTERM cancel the run and stop its subprocesses; exit codes 0, 2, 1, 130 and 143
- [x] 5.7 Lockfile paths relative to the working directory; replay checks the bundle's hash; a pass whose provider cannot start writes its sample and its `pass ends` line
- [x] 5.8 Tests for each, failing before the fix; a live one-domain run, its cancel, resume and byte-identical replay
- [x] 5.9 Run every copperhead-tools call, replay included, in the review's working directory (copperhead-tools bundle version 2 names paths relative to it); live check a record written outside a repository, copied in, and replayed from its root
- [x] 5.10 Second Codex review: a cancellation during the manifest lookup is still one; `--resume` keeps a pass only under the same model, templates and budgets; the time budget stops work in flight; the ending turn's sample records its outcome; a sample that cannot be saved ends the pass; a `propose` batch is checked whole; an empty `--domains` is refused
- [x] 5.11 Third Codex review: a kept pass is bound to the bundle it read; a pass that runs out of turns or time saves that ending before cleanup; a cancelled replay exits 130 or 143
- [x] 5.12 Fourth Codex review: `inputs.json` records the review's inputs and `--resume` refuses other ones; a query or pre-check cut short by a stop ends the pass cancelled or out of time; a stopped pass aborts its provider request, through a `signal` the OpenAI and Anthropic providers pass to their SDKs
- [x] 5.13 Fifth Codex review: the resume input check does not depend on the bundle, and `--resume` refuses a directory that is not a record; review passes get a `compat:<id>` model's endpoint settings
- [x] 5.14 Sixth Codex review: `--resume` and `--replay` refuse a record holding a symbolic link
- [x] 5.15 Seventh Codex review: `--out` must lie outside a reused `--sweep`; a resumed or replayed record holding a hard-linked file is refused
- [x] 5.16 Eighth Codex review: replay refuses a record inside an input it names; claude-code and cursor start a new session after close(); a call the stop cut short is recorded

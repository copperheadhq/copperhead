# cli-surface: Delta Spec

## ADDED Requirements

### Requirement: `review` command
The CLI SHALL provide `copperhead review [design] --out <dir>`, marked experimental, with `--source`, `--fab`, `--fab-profile`, `--model`, `--domains`, `--max-turns`, `--max-minutes`, `--parallel`, `--label`, `--sweep`, `--tools`, `--replay` and `--resume`. It SHALL refuse an `--out` that is not empty, or that lies inside the design or inside a `--source`, `--fab` or `--sweep` input once symbolic links are resolved, and SHALL never write the design. It SHALL refuse a `--max-turns` or `--parallel` that is not a positive whole number, a `--max-minutes` that is not a positive number, and a `--domains` that names no domain, before writing anything. It SHALL exit 0 when every pass ended and the report was written, 2 when the report was written but a pass failed, 1 on an error or a replay that differs, with a message and without a stack trace, and 130 or 143 when cancelled by SIGINT or SIGTERM.

#### Scenario: Record outside the design
- **WHEN** `copperhead review ./board --out ./board/review` is run
- **THEN** it exits non-zero naming the rule that the record lies outside the design, and writes nothing

#### Scenario: Record reached through a link
- **WHEN** `--out` names a symbolic link outside the design that points to an empty directory inside it
- **THEN** it exits non-zero naming the same rule, and writes nothing into the design

#### Scenario: Budget that is not a number
- **WHEN** `copperhead review --out ./record --max-turns nope` is run
- **THEN** it exits 1 naming `--max-turns`, and creates no record

#### Scenario: Cancelled
- **WHEN** a running review receives SIGTERM
- **THEN** it stops its model passes and copperhead-tools processes, keeps every pass's sample, and exits 143; `--resume` then reruns the passes that had not ended

#### Scenario: Replay
- **WHEN** `copperhead review --replay <record>` is run on an unchanged record
- **THEN** it re-verifies the stored proposals with no model, reports the replay identical, and exits 0

### Requirement: Text tool protocol argument shapes
A text-protocol tool call SHALL take its arguments from `args`, else from `arguments`, `parameters` or `input` when that key holds an object, else from the keys beside `tool`. A reply in which no call parsed but which writes an `<invoke name="...">` block naming an advertised tool SHALL get a nudge saying the block is not read and showing the JSON form.

#### Scenario: Flat arguments
- **WHEN** a model replies `{"tool": "search", "pattern": "SDO"}` for an advertised `search` tool
- **THEN** the call's arguments are `{"pattern": "SDO"}`

#### Scenario: Invoke block
- **WHEN** a model replies with only `<invoke name="board"></invoke>` for an advertised `board` tool
- **THEN** no call runs, and the nudge names `board`, the `<invoke>` block and `{"tool": "board", "args": { ... }}`

### Requirement: Resuming a killed run
`copperhead review --resume --out <dir>` SHALL reuse the record's sweep and bundle, keep every pass whose sample records an end (submitted, turns or time exhausted, stalled) under the same model, prompt templates, budgets and bundle as the resumed run, keep any other sample beside a fresh rerun of its pass, and then verify and record as a fresh run would. A bundle that does not parse SHALL be rebuilt. The record SHALL hold `inputs.json`, the design, sources, fabrication inputs, profile, sweep and label as the run named them from its working directory, and a resume that names other inputs, or whose `--out` holds anything but no readable `inputs.json`, SHALL be refused before anything runs, whether or not the record got as far as its bundle. A resumed or replayed record holding a symbolic link, or a file with another hard link, anywhere SHALL be refused before anything is written. Review passes SHALL use the model's provider as other commands build it, a `compat:<id>` model with its configured endpoint and key variable.

#### Scenario: One pass failed
- **WHEN** a record holds seven submitted passes and one that failed, and `--resume` is run
- **THEN** only the failed domain's pass runs, and the bundle is not rebuilt

#### Scenario: Resumed with another design
- **WHEN** a record was made with `review ./board --out record` and `review --resume --out record` is run, which names the working directory as the design
- **THEN** it exits 1 naming the record's inputs and the ones given, and runs nothing

#### Scenario: Resumed with another model
- **WHEN** `--resume` is run with a `--model` other than the one a submitted pass ran with
- **THEN** that pass runs again, so the lockfile's model is the one every kept pass used

### Requirement: Progress lines
`copperhead review` SHALL write its progress to stderr, one line per event, in these forms, which an editor integration parses: `sweep: <JSON summary>` or `sweep: using the record at <dir>`; `bundle: <JSON summary>`; `[<domain>] pass starts (<title>)`; `[<domain>] pass ends: <outcome> after <n> turns, <n> proposals, <n> s`, followed by a space and `(<error>)` when the pass recorded one; and on resume `[<domain>] resume: keeping the pass that ended <outcome> after <n> turns`. Every pass that starts SHALL write its `pass ends` line, a pass whose provider could not start included. Progress lines SHALL be redacted like samples.

#### Scenario: Provider cannot start
- **WHEN** the model provider for a pass fails to start
- **THEN** stderr holds `[<domain>] pass starts (<title>)` followed by `[<domain>] pass ends: failed after 0 turns, 0 proposals, 0 s (<error>)`, and the pass's sample is written

# cursor-cli-provider — Delta Spec

## ADDED Requirements

### Requirement: Saved-login cursor provider

copperhead SHALL provide a `cursor` provider, selected by `--model cursor` or `--model cursor:<model-id>`, that drives the locally installed Cursor Agent CLI and reuses its saved login (`agent login`). Running with this provider SHALL NOT require `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. copperhead SHALL NOT read, copy, or log credentials.

#### Scenario: cursor runs without API keys
- **WHEN** `do "<request>" --model cursor` runs with a logged-in Cursor CLI and no OpenAI/Anthropic keys
- **THEN** the run uses the `cursor` provider and proceeds through the normal agent loop

### Requirement: Reasoning-only enforcement

The `cursor` provider SHALL run the CLI in plan mode with sandbox enabled and an isolated workspace. copperhead's tool catalog SHALL be advertised via the shared JSON prompt protocol. If the CLI output indicates native tool execution or file mutation, the provider SHALL throw and fail the run.

#### Scenario: Tripwire on native tool execution
- **WHEN** the CLI JSON stream contains a native tool/mutation event
- **THEN** `chat()` throws before returning tool calls to the loop

### Requirement: Malformed model output is tolerated

When the model reply does not contain a parseable copperhead tool-call JSON object, the provider SHALL return assistant text with empty `toolCalls` rather than throwing.

### Requirement: Fabricated tool results are discarded
When the model's reply continues past its tool calls in the harness's own transcript format (a line holding only `[result of <tool>]` or `[user]`), the provider SHALL treat everything from that line on as fabricated: it SHALL dispatch only the tool calls before it, SHALL NOT return the discarded text as assistant content, and SHALL return a notice naming the number of discarded blocks and tool calls, which the loop sends to the model after the real tool results. The discarded text SHALL be recorded in the transcript. A skill's sub-run SHALL send the same notice and record the same event. A marker inside a JSON string value, or not alone on its line, SHALL NOT cut the reply.

#### Scenario: A reply invents its own tool result
- **WHEN** a turn's reply holds a tool call, then a line `[result of run_drc]` with invented output, then a second tool call
- **THEN** only the first call is dispatched, the reply's stored text ends before the invented result, the model's next user message says one block and one call were discarded, and the transcript has a `fabricated-results` event carrying the discarded text

#### Scenario: A result quoted inside a JSON string
- **WHEN** a `write_file` call's `content` string contains the text `[result of run_drc]`
- **THEN** the call is dispatched unchanged and no notice is produced

#### Scenario: A skill's sub-run invents a tool result
- **WHEN** a skill's sub-run gets a reply cut for an invented `[result of …]` block
- **THEN** the sub-run sends the notice after the real results and the transcript has a `fabricated-results` event naming the skill

### Requirement: Undispatched calls in a mixed reply are named
When a reply dispatches at least one tool call and also holds tool-call JSON that did not run (a tool outside the turn's catalog, or a call that does not parse), the provider SHALL return those tool names with the turn, and the loop SHALL send the model one message after the real tool results naming them and record an `undispatched-calls` event (AC-3.22). A `finish` in that reply SHALL be answered as not run, naming those calls, and SHALL NOT end the run (AC-3.23). Nothing that did not run before SHALL be dispatched, so the edit lock is unchanged.

#### Scenario: A write after validate_change in the same reply
- **WHEN** one reply calls `propose_change`, `validate_change`, then `write_file`, and `write_file` was not in the turn's catalog
- **THEN** the first two calls run, the next message names `write_file` as available now, and the transcript has an `undispatched-calls` event listing it

#### Scenario: A finish rides in the same reply
- **WHEN** that reply also ends with `finish`
- **THEN** `finish` is answered as held back with `write_file` named, the run does not commit, and the next reply can send the write and finish

### Requirement: No silent fallback to a paid API

A rate-limited or errored `cursor` run SHALL NOT continue on OpenAI/Anthropic providers.

#### Scenario: Missing CLI or auth
- **WHEN** `agent` is not found or the user is not logged in
- **THEN** the run fails with an actionable message referencing `agent login` / `agent status` and `COPPERHEAD_CURSOR_PATH`

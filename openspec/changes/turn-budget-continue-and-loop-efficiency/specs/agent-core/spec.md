# agent-core delta spec

## ADDED Requirements

### Requirement: Continue prompt on turn-budget exhaustion

When `maxTurns` is reached in an attended run, the loop SHALL invoke the budget-exhaustion callback with run statistics (turns used, files touched, open obligation count, and cumulative token usage in/out) and offer to continue with additional turns. If the callback grants extra turns, the loop SHALL extend the budget and continue the conversation without losing state; the callback MAY fire again at the next exhaustion. If the callback declines, is absent (non-interactive/CI), or stdin is not a TTY, the run SHALL fail exactly as before.

#### Scenario: Attended run continues (AC-15.1)

- **WHEN** a run reaches `maxTurns` and the budget-exhaustion callback returns a positive number of extra turns
- **THEN** the loop continues from the same conversation state, a `budget-extended` event with the granted turns and token usage is written to the transcript, and the run can still finish with outcome success

#### Scenario: Attended run declines (AC-15.2)

- **WHEN** a run reaches `maxTurns` and the callback returns 0
- **THEN** the run fails with the turn-budget-exhausted reason and the pre-run snapshot is restored, as today

#### Scenario: Non-interactive run unchanged (AC-15.3)

- **WHEN** a run reaches `maxTurns` and no budget-exhaustion callback was provided
- **THEN** the run fails and restores exactly as before this change

#### Scenario: Token usage visible at the decision point (AC-15.4)

- **WHEN** the budget-exhaustion callback is invoked
- **THEN** the statistics it receives include `tokensIn` and `tokensOut` matching what the summary would report

### Requirement: Tool-call batching guidance

The system prompt workflow SHALL instruct the model to emit multiple independent tool calls in a single response (all `record_constraint` calls together, all `resolve_affected` calls together, independent `write_file` calls together), and the 5-turns-remaining nudge SHALL repeat the batching instruction.

#### Scenario: Batching stated in the system prompt (AC-15.5)

- **WHEN** the system prompt is built
- **THEN** it contains an explicit instruction to emit multiple independent tool calls in one response

#### Scenario: Batching stated in the convergence nudge (AC-15.6)

- **WHEN** 5 turns remain and no finish has been requested
- **THEN** the injected nudge message includes the batching instruction

### Requirement: Batch resolution of revisit obligations

`resolve_affected` SHALL accept an optional `resolutions` array of `{constraint_key, item, resolution}` objects alongside the single form, resolve each entry independently, and report the outcome per entry so one invalid entry does not invalidate the rest.

#### Scenario: One call clears a backlog (AC-15.9)

- **WHEN** `resolve_affected` is called with a `resolutions` array covering three open obligations
- **THEN** all three obligations clear in that single call and each resolution is recorded as a decision

#### Scenario: Mixed valid and invalid entries (AC-15.10)

- **WHEN** the `resolutions` array contains one matching and one non-matching entry
- **THEN** the matching entry resolves, and the result names the non-matching entry with the currently open obligations to match against

### Requirement: Convergence feedback in tool results

Tool results SHALL steer the model toward convergence: `run_erc` and `run_drc` without a configured schematic/board state that the check does not apply yet and should not be retried until the artifact exists; `search` rejects an empty pattern with a corrective hint instead of a generic missing-argument error.

#### Scenario: ERC not applicable is terminal, not retryable (AC-15.12)

- **WHEN** `run_erc` is called with no schematic configured
- **THEN** the result says ERC does not apply yet and should not be retried until a schematic exists, rather than a bare "no schematic configured"

#### Scenario: Empty search pattern is corrected (AC-15.13)

- **WHEN** `search` is called with an empty `pattern`
- **THEN** the result explains a non-empty regex is required and gives an example, without consuming further turns on retries of the same mistake

### Requirement: Anthropic prompt caching

The Anthropic provider SHALL send `cache_control: {type: "ephemeral"}` breakpoints on the system prompt block, the last tool definition, and the last content block of the final message, and SHALL include cache-read and cache-creation input tokens in the reported `inputTokens` usage.

#### Scenario: Breakpoints present in the request (AC-15.14)

- **WHEN** the Anthropic provider builds a request with a system prompt, tools, and messages
- **THEN** the request carries exactly three cache-control breakpoints: system block, last tool, last message block

#### Scenario: Cached tokens are counted (AC-15.15)

- **WHEN** the API response reports `cache_read_input_tokens` or `cache_creation_input_tokens`
- **THEN** the turn's `inputTokens` is the sum of uncached, cache-read, and cache-creation input tokens

### Requirement: KiCad edit loadability validation

After `edit_file` writes a `.kicad_sch` or `.kicad_pcb` file, the loop SHALL probe the file's loadability with kicad-cli. If the file was loadable before the edit but not after, the edit SHALL be reverted and the tool result SHALL carry kicad-cli's own error plus corrective guidance. If the file was already unloadable before the edit, the edit SHALL be kept (reverting would deadlock incremental repair) with the probe output in the result. Files kicad-cli cannot probe standalone (`.kicad_pro`, `.kicad_sym`, `.kicad_mod`) SHALL NOT be probed or reverted.

#### Scenario: Corrupting edit is reverted with the reason (AC-15.20)

- **WHEN** an `edit_file` call would make a previously loadable schematic fail to load in KiCad
- **THEN** the file is restored to its pre-edit content and the result says the edit was reverted, quoting kicad-cli's error

#### Scenario: Unprobeable KiCad files are edited normally (AC-15.21)

- **WHEN** `edit_file` targets a `.kicad_pro`, `.kicad_sym`, or `.kicad_mod` file
- **THEN** the edit is applied without any loadability probe or revert

#### Scenario: Already-corrupt files accept repair edits (AC-15.22)

- **WHEN** `edit_file` targets a schematic that already failed to load before the edit
- **THEN** the edit is kept, and the result says the file was already unloadable and repair should continue

### Requirement: Stall detection counts consecutive tool-less turns

The no-tool-call nudge counter SHALL reset whenever the model calls tools again, so only consecutive tool-less turns count toward the stopped-without-finishing failure.

#### Scenario: Sporadic empty completions do not fail a converging run (AC-15.27)

- **WHEN** empty completions occur non-consecutively across an otherwise productive run
- **THEN** the run is not failed for stalling; only three tool-less turns in a row are

### Requirement: Withheld tool calls and finish refusal

When a reply contains tool calls not present in the current turn's tool catalog, those calls SHALL be recorded as withheld, and any `finish` call in the same reply SHALL be refused with feedback indicating the unexecuted calls.

#### Scenario: Finish refused when reply contains withheld calls

- **WHEN** a model emits a batched reply containing both a withheld tool call and a `finish` call
- **THEN** `finish` is not dispatched, a tool result indicates the withheld call did not run, and the run does not commit

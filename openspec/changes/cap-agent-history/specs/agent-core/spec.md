# agent-core — Delta Spec

## ADDED Requirements

### Requirement: The conversation sent each turn is capped
The agent loop SHALL send the provider a capped view of the conversation rather than the full accumulated history, so a long stage does not re-send and re-pay for content the model no longer needs. Capping SHALL affect only the request: the run's own message history, the JSONL transcript, and the obligations ledger SHALL retain full fidelity. Capping SHALL be enabled by default and disableable with the `historyCap` config field.

#### Scenario: a settled oversized tool result is clipped
- **GIVEN** a conversation with a tool result longer than the result cap, outside the recent window
- **WHEN** the next turn is sent to the provider
- **THEN** the provider receives a clipped result that states how much was removed and how to recover it, and the untouched original remains in the transcript

#### Scenario: capping can be turned off
- **GIVEN** `historyCap` is set to false in `.copperhead/config.json`
- **WHEN** a turn is sent
- **THEN** the provider receives the conversation exactly as accumulated, with nothing trimmed

### Requirement: Capping preserves message identity
Capping SHALL preserve the number of messages, their order, their roles, and every `toolCallId`, shrinking only content strings and oversized tool-call argument strings. It SHALL NOT drop, merge, reorder, or re-identify a message, because the session-resume path indexes into the message array (`renderDelta(messages, sentCount)`) and every provider pairs a tool result to its call by id.

#### Scenario: identity survives a capping pass
- **GIVEN** a conversation in which several messages are eligible for trimming
- **WHEN** the capped view is built
- **THEN** it has the same length, the same sequence of roles, and the same `toolCallId` values in the same order as the input

#### Scenario: the caller's history is not mutated
- **GIVEN** a conversation passed to the capping function
- **WHEN** the capped view is built
- **THEN** the original array and its messages are unchanged

#### Scenario: the capped view is structurally independent
- **GIVEN** a capped view handed to a provider
- **WHEN** the provider mutates a message's content, or a tool call's arguments, in what it was handed
- **THEN** the run's own history is unaffected, because the view's messages, tool-call arrays, and argument objects are all fresh

### Requirement: A superseded file read is replaced rather than re-sent
When a `read_file` result is followed later in the same conversation by another read of the same path whose line span contains the earlier read's span, the earlier result SHALL be replaced with a short stub naming the path, since those contents are already present in the conversation. A read with no `start_line`/`end_line` SHALL be treated as covering the whole file. An earlier read SHALL NOT be superseded by a later read that covers only part of it, because `read_file` returns only the requested span and the earlier content would otherwise be lost. The span a read is credited with SHALL match the span the tool actually returned: `read_file` line bounds SHALL be normalized to a finite number or an absent bound before the span is computed, so a bound supplied as a numeric string (e.g. `"4"`, which the tool reads as a partial read) cannot be mistaken for a whole-file read and wrongly supersede real content. This replacement SHALL apply regardless of how recent the earlier read is, because the later read already carries those contents. The most recent read of a path SHALL always be sent in full.

#### Scenario: an earlier read of a re-read path is replaced
- **GIVEN** a conversation that reads the same schematic in full twice
- **WHEN** the capped view is built
- **THEN** the earlier result is replaced by a stub naming the path and directing the model to the newer read, and the later result is sent in full

#### Scenario: a partial later read does not supersede a whole-file read
- **GIVEN** a conversation that reads a file in full, then reads only lines 100 to 120 of it
- **WHEN** the capped view is built
- **THEN** the whole-file result is sent unchanged, because the later read does not contain it

#### Scenario: a stringified line bound is not mistaken for a whole-file read
- **GIVEN** a conversation that reads a file in full, then reads it again with `start_line` supplied as the string `"4"`
- **WHEN** the capped view is built
- **THEN** the whole-file result is sent unchanged, because the second read is credited only with the partial span the tool actually returned, not the whole file

#### Scenario: disjoint ranged reads do not supersede each other
- **GIVEN** a conversation that reads lines 1 to 50 of a file, then lines 100 to 120 of the same file
- **WHEN** the capped view is built
- **THEN** neither result is superseded

#### Scenario: a wider later read supersedes a narrower earlier one
- **GIVEN** a conversation that reads lines 10 to 20 of a file, then lines 1 to 100 of the same file
- **WHEN** the capped view is built
- **THEN** the earlier narrower result is replaced by a stub, because the later read contains its span

#### Scenario: reads of different paths are independent
- **GIVEN** a conversation that reads two different files once each
- **WHEN** the capped view is built
- **THEN** neither result is superseded

#### Scenario: a failed read never supersedes a successful one
- **GIVEN** a conversation that reads a file successfully, then attempts the same path again and gets a failure result
- **WHEN** the capped view is built
- **THEN** the successful result is sent unchanged, because a failed read returned no content to replace it with

#### Scenario: a file whose contents resemble an error is still a successful read
- **GIVEN** a conversation that twice reads a file whose contents begin with the same words a tool failure would
- **WHEN** the capped view is built
- **THEN** the earlier read is superseded as normal, because failure is recorded from the call's outcome rather than inferred from its text

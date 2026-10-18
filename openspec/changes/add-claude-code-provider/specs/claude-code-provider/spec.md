# claude-code-provider — Delta Spec

## ADDED Requirements

### Requirement: Saved-login provider needs no API key
copperhead SHALL provide a `claude-code` provider, selected by `--model claude-code` or `--model claude-code:<model-id>`, that drives the locally-installed Claude Code through the Claude Agent SDK and reuses its authentication. Running with this provider SHALL NOT require `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; authentication SHALL be resolved by the SDK from the environment (e.g. `CLAUDE_CODE_OAUTH_TOKEN` minted by `claude setup-token`, or a logged-in Claude Code CLI). copperhead SHALL NOT read, copy, or log the credential.

#### Scenario: Run with no API key
- **WHEN** `do "<request>" --model claude-code` runs with `CLAUDE_CODE_OAUTH_TOKEN` set and neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` present
- **THEN** the run proceeds against the Claude Code login and completes through the normal verify/commit path, and no API-key material appears anywhere in the transcript, summary, or working tree

#### Scenario: No credential is touched by copperhead
- **WHEN** a `claude-code` run executes
- **THEN** copperhead performs no read of the Claude Code credential store and the provider constructor performs no API-key check

### Requirement: Reasoning-only single-turn mapping
The `claude-code` provider SHALL implement the `Provider.chat(messages, tools) -> Turn` seam as a reasoning-only backend: each `chat()` call SHALL issue exactly one Agent SDK `query()` with no SDK tools registered and the SDK's built-in file/bash/web tools disabled, run in an isolated working directory, so the SDK executes no tools. copperhead's agent loop SHALL remain the driver, and every mutation SHALL flow through copperhead's capability-filtered tools, obligations ledger, ERC/DRC verification, git snapshot, and commit gate exactly as for the other providers.

#### Scenario: SDK executes nothing
- **WHEN** the `claude-code` provider issues a turn
- **THEN** the SDK is invoked with an empty tools allowlist, a wildcard-led disallow list, and a `canUseTool` handler that denies every tool, in a working directory outside the repository, and returns a single assistant response that copperhead maps to `{ text, toolCalls, usage }`

#### Scenario: Scratch working directory does not outlive the run
- **WHEN** a run using the `claude-code` provider ends and `loop.ts` calls `close()` on it
- **THEN** the isolated scratch working directory the provider created is removed

#### Scenario: SDK tool execution is refused loudly
- **WHEN** the SDK returns an assistant message containing a `tool_use` block (i.e. it did not honor the disabled-tools option)
- **THEN** the provider throws immediately with a message naming the violated invariant, rather than continuing, so no unverified action can bypass copperhead's gates

#### Scenario: A billed API key is not used for a saved-login run
- **WHEN** a `claude-code` turn runs while `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) is also set in the environment
- **THEN** those keys are stripped from the SDK subprocess environment so the run authenticates via the saved login, never silently against a billed API

#### Scenario: Safety gates apply to claude-code
- **WHEN** a `claude-code` run's edits leave ERC/DRC violations that persist past `maxRepairCycles`
- **THEN** the working tree is restored byte-identical to the pre-run state and the run exits non-zero, identical to the behavior with `gpt-5` or `claude`

### Requirement: Structural tool gating is preserved
The provider SHALL advertise exactly the tools `availableTools(ctx)` returns for the current turn, and SHALL parse the model's tool selection back into `Turn.toolCalls`. A tool that is not in the advertised set for a turn SHALL NOT be callable that turn, keeping the spec-gated-in invariant structural rather than schema-mirrored.

#### Scenario: Locked edit tools are not advertised
- **WHEN** a turn runs before the change proposal has validated
- **THEN** the edit tools (`edit_file`, `write_file`) are absent from what the provider advertises to the model, and any attempt to call them is refused by `dispatchTool`

### Requirement: No silent fallback to a paid API provider
A `claude-code` run that is rate-limited or errors SHALL NOT be silently continued on a keyed (`gpt-5`/`claude`) provider. The provider SHALL preserve the SDK error's status so copperhead's retry/backoff still applies, but the provider-swap failover SHALL NOT select a keyed provider for a `claude-code` run.

#### Scenario: Rate limit does not fail over to a keyed provider
- **WHEN** a `claude-code` turn is rate-limited (HTTP 429)
- **THEN** copperhead applies its exponential backoff retry and, on exhaustion, fails the run rather than switching to `gpt-5` or `claude`

### Requirement: Missing or unauthenticated install fails with an actionable error
When the optional `@anthropic-ai/claude-agent-sdk` dependency is not installed, or the Claude Code install is present but unauthenticated, the provider SHALL surface an actionable error and the run SHALL fail through copperhead's normal rollback path leaving the tree unchanged — never a raw stack trace with no guidance.

#### Scenario: Optional dependency not installed
- **WHEN** `--model claude-code` is used but `@anthropic-ai/claude-agent-sdk` is not installed
- **THEN** the run fails with a message telling the user to install the optional dependency, and the working tree is unchanged

#### Scenario: Not logged in
- **WHEN** `--model claude-code` is used with no usable Claude Code authentication
- **THEN** the run fails with a message pointing the user to log in / run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`, and the working tree is unchanged

### Requirement: Malformed model output is tolerated
When the model's reply does not contain a parseable tool-call JSON object, the provider SHALL treat the reply as assistant text (no tool calls) rather than throwing, so a non-conforming turn degrades to the loop's normal stall/nudge handling.

#### Scenario: Unparseable tool block
- **WHEN** a `claude-code` turn returns text that is not a valid tool-call JSON object
- **THEN** `chat()` returns a `Turn` with that text and an empty `toolCalls` array, and does not throw
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

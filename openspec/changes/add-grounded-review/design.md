# add-grounded-review: Design

## Context

copperhead calls models; copperhead-tools never does, and copperhead never imports it: the JSON
protocol is the only coupling. RFC 13 Section 18.4 makes the set of tools a review runs data, not a
model's choice; RFC 17 Section 4.1 lets a model pass call read-only queries over its bundle and
records each call. The agent loop (`runAgentLoop`) snapshots the repository, restores it with
`git reset --hard` on failure and commits on success; none of that belongs in a review, which must
leave the design untouched.

## Decisions

- **D1. The sweep is fixed.** The command always runs the copperhead-tools `review` composite first,
  over the design and every fabrication output given; the model never decides whether a check runs.
  Alternative: let the model call deterministic checks as it sees fit. Lost: "not flagged" would
  then mean "not called", and RFC 13 Section 18.4 forbids it.
- **D2. Model-initiated calls are queries.** A pass's tools are `review-query` operations, a
  `propose` call that runs `review-verify` over the pass's proposals as a pre-check, and `submit`.
  None writes. Their results are inputs to proposals and never findings themselves.
- **D3. Own loop, not `runAgentLoop`.** A pass is a small loop over `Provider.chat`: no git preflight,
  snapshot, restore, commit, obligations ledger or repair cycles. Alternative: a skill sub-run. Lost:
  skills share the parent's context and run sequentially, and a review has no parent run.
- **D4. Domain prefixes.** A pass's proposal ids, premises and calculation origins are prefixed with
  its domain letter, so eight passes' proposals merge without collision and a finding can only rest on
  its own pass's premises.
- **D5. Samples saved every turn.** A pass writes its record after every turn. A run killed by a
  session restart or a suspend leaves every proposal it had made. Alternative: write at the end.
  Lost: the first full run on the target board was killed at about 30 turns per pass and left
  nothing.
- **D6. Replay compares bytes.** `--replay` re-verifies the stored proposals into `replay/` and
  compares the report with the recorded one and with the lockfile's hash; a changed proposals file is
  refused before verifying.
- **D7. Lenient argument parsing.** The text protocol reads `args`, then `arguments`, `parameters`,
  `input`, then the remaining top-level keys. A schema-shaped call is unaffected.
- **D8. Resume and timeouts.** Samples record `running` until a pass ends, and are written whole (a temporary file renamed over the last) after every turn, whichever way it ended; `--resume` refuses a record whose `inputs.json` names other inputs than the resumed run, and keeps ended passes that ran under the same model, prompt templates, budgets and bundle (each sample records them) and reruns the rest from scratch (an interrupted conversation is not continued: its transcript is kept beside the rerun, and an unreadable sample is treated as interrupted). The turn timeout is the agent loop's inactivity watchdog: a turn that keeps streaming is not hung, a turn with no response or progress for 10 minutes is retried once and two in a row end the pass `failed`, and a turn still producing output at 30 minutes ends it at once. A rate-limited turn is retried with backoff, as in the agent loop. Alternative: a whole-turn deadline. Lost: the first full run lost its MCU pass to one slow turn.
- **D9. Cancel and exit codes.** SIGINT or SIGTERM aborts the run: each pass's in-flight turn is torn down (its provider closed, which stops the Claude Code subprocess), copperhead-tools processes are stopped, every sample is written with the pass `failed`, error `cancelled`, and the command exits 128 plus the signal number. `--resume` reruns those passes. A completed run exits 0, or 2 when a pass failed: the report then covers the passes that ended, and `--resume` reruns the rest. Alternative: exit 0 whenever a report was written. Lost: a run in which every pass failed (no login, say) would look like a clean review.
- **D10. A record that can be committed.** The record is meant to be committed beside the design, so the lockfile names a path inside the working directory relative to it (absolute outside it), the bundle names its paths relative to itself, and `--out` is checked against the design and every input after resolving symbolic links. copperhead-tools runs in the review's working directory, where its version 2 bundle names files relative to it, so a record written outside the repository and copied in replays from the repository's root. The stderr progress lines (`sweep:`, `bundle:`, `[<domain>] pass starts`, `[<domain>] pass ends`) are an interface an editor integration parses; a test pins them.

## Risks

- **Cost and time.** Eight passes of up to 40 turns each, one tool call per turn on text-protocol
  providers. Budgets are per pass (turns and minutes) and `--parallel` bounds concurrency.
- **Anchoring.** The digest puts what the sweep did not examine before the source index, and each
  domain task names its scope, so a pass starts from the gaps rather than from the sweep's findings.
- **Provider pinning.** The claude-code provider cannot pin decoding or an exact model version; the
  lockfile records that, and replay does not depend on it.

# Proposal: harden-stage-recovery

## Why

A `create --model claude-code` run of an eight-stage motor driver spent 45 minutes finishing two stages: part selection ran three 40-turn attempts, each rolled back to nothing, and the first of them had already refused over a constraint no retry could satisfy (a 6 A relay against a 16 A `protection.precharge_bypass` minimum). The pipeline retried anyway, discarded the draft BOM twice, and ended by stopping for a human with no draft, no named decision, and a cost table reading "2 input tokens, 0% cache hits". The same shape is recorded in issues #446, #135, #197 and #208. The pipeline needs a recovery system that classifies why a stage attempt ended, keeps what the attempt built, escalates the budget when the budget was the problem, and stops with one clear question when a person's decision is the only way forward.

## What Changes

- **Structured refusal blockers.** `finish` with outcome `refuse` accepts an optional `blockers` list; a blocker of kind `constraint-conflict` names a registered constraint key, the value it requires, and the candidate that fails it. A blocker naming a key that is not in the constraint registry is downgraded to prose, so narration alone cannot stop the pipeline (I15/#197 holds).
- **Cause-keyed retry policy in `create`.** A stage attempt's end is classified before any retry: `constraint-conflict` (verified blocker) stops the stage for a human, with no supervisor call and no retry; `turn-budget-exhausted` retries with an escalated budget (1.5× the previous attempt's, rounded up, capped at 3× the stage's starting budget); every other cause goes to the recovery supervisor as today.
- **Decision stop.** The constraint-conflict stop prints a decision block naming each conflicting constraint (key, required value, failing candidate, attempt), the two ways out (revise the constraint and its source, or name a compliant part in the brief or SUBSYSTEMS.md), and that re-running `create` resumes at this stage. The block is also written to the attempt's `summary.md`. The pipeline exits non-zero and leaves no partial docs behind except the preserved draft (below).
- **Draft continuity for docs-only stages.** For spec-seed, architecture and part-selection (stages whose mutations are docs, `openspec/` and the constraint registry, never KiCad files), a refused attempt preserves its touched work in the same `copperhead failed run <run-id>` stash entry a failed attempt already leaves, and the next attempt starts with that work applied to the tree, so a retry continues the draft instead of re-deriving it. Recovery guidance names the preserved files. KiCad-touching stages keep today's rollback (checkpoint commits are #208, separate).
- **Honest telemetry.** The `claude-code` provider counts cache-read and cache-creation tokens in reported input usage, matching the Anthropic provider (AC-15.15). The create cost table labels its cache column as replayed turns from copperhead's response cache, and every stage attempt boundary (start, end, cause) is a logged stage line, so a watching user sees attempts 2 and 3, not a silent log.

Out of scope, tracked separately: the CLI tool protocol's "exactly one JSON object" wording (#192, a fix PR), pre-resolving architecture parts against installed symbols before part selection (follow-up change), checkpoint commits for KiCad stages (#208), and the duplicate spec-seed run seen in the same log (cause unknown; needs the create.log).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-core`: `finish` gains structured refusal blockers, verified against the constraint registry before they count; the refused outcome carries them to the caller.
- `create-pipeline`: stage retries are keyed on a classified cause (stop on verified constraint conflict, escalate on budget exhaustion, supervise the rest); docs-only stages resume a retry from the preserved draft; attempt boundaries are always logged; the cost table names its cache column truthfully.
- `safety-rails`: a refused run with touched files preserves the work in the failed-run stash entry exactly as a failed run does, before restoring the snapshot.
- `claude-code-provider`: reported input usage includes cache-read and cache-creation tokens.

## Impact

- `src/agent/tools.ts` (`finish` schema and handler), `src/agent/loop.ts` (refusal path preserves work; result carries blockers), `src/agent/context.ts` (finish request shape).
- `src/commands/create.ts` (cause classification, escalation, decision stop, stash apply for docs-only stages, attempt logging, cost table label), `src/agent/recovery.ts` (supervisor receives the cause; no call on constraint conflict).
- `src/agent/providers/claude-code.ts` (usage accounting).
- `src/util/git.ts` (apply a preserved stash entry by name).
- SPEC.md §4.5 and §2.5 ("The one stop" becomes "The two stops"), new AC-18 section; `openspec/specs/SPEC.md` acceptance criteria.
- Tests: `test/` unit coverage for classification, escalation arithmetic, blocker verification, stash apply, and provider usage; no live-LLM test required.
